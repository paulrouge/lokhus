import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseUnits, zeroAddress, type PublicClient } from 'viem'
import type { ActionContext, ActionPlugin } from '../plugins.ts'
import type { Address, Hex, MetaTx, TxAction } from '../types.ts'
import { erc20Abi } from '../safe/abi.ts'
import { formatTokenAmount } from '../safe/activity.ts'
import {
  HUB_USER_ROUTER,
  SODAX_CHAINS,
  ensure,
  sodaxRelayPacket,
  sameAddress,
  sodaxAssetManagerAbi,
  sodaxHubCallsParams,
  sodaxHubWallet,
  verifyToken,
  type SodaxChain,
} from './sodax.ts'

export const SODAX_LENDING_POOL: Address = '0x553434896D39F867761859D0FE7189d2Af70514E'
const HUB_ASSET_MANAGER: Address = '0x60c5681bD1DB4e50735c4cA3386005A4BA4937C0'
const WRAPPED_SONIC: Address = '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38'
const BACKEND = 'https://api.sodax.com/v1/be'
const RELAY = 'https://api.sodax.com/v1/relay'
const HUB_RELAY_ID = 146n
const RAY = 1e27
const SECONDS_PER_YEAR = 31_536_000
const CACHE_MS = 60_000

const poolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReservesList() view returns (address[])',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
])
const vaultAbi = parseAbi([
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
  'function tokenInfo(address token) view returns (uint8 decimals, uint256 depositFee, uint256 withdrawalFee, uint256 maxDeposit, bool isSupported)',
])
const routerAbi = parseAbi(['function route((address addr, uint256 value, bytes data)[] calls) payable'])
const wrappedSonicAbi = parseAbi([
  'function deposit() payable',
  'function withdrawTo(address account, uint256 value) returns (bool)',
])
const connectionAbi = parseAbi(['function sendMessage(uint256 dstChainId, bytes dstAddress, bytes payload) payable'])
const transferFromAbi = parseAbi(['function transferFrom(address from, address to, uint256 amount) returns (bool)'])
const totalSupplyAbi = parseAbi(['function totalSupply() view returns (uint256)'])

export interface LendMarket {
  symbol: string
  name: string
  address: Address
  decimals: number
  hubAsset: Address
  vault: Address
  supplyApy: number
  borrowApy: number
  frozen: boolean
}

interface HubCall {
  to: Address
  value: bigint
  data: Hex
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>()

const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>
  const value = load()
  value.catch(() => cache.delete(key))
  cache.set(key, { at: Date.now(), value })
  return value
}

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`SODAX ${url.replace(/^https:\/\/[^/]+/, '')}: HTTP ${response.status}`)
  return response.json() as Promise<T>
}

const rayToApy = (rate: string) => {
  const apr = Number(rate) / RAY
  return Number.isFinite(apr) ? Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1 : 0
}

const toWad = (decimals: number, amount: bigint) =>
  decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18)

const fromWad = (decimals: number, amount: bigint) =>
  decimals <= 18 ? amount / 10n ** BigInt(18 - decimals) : amount * 10n ** BigInt(decimals - 18)

const fromReserve = (market: LendMarket, amount: bigint) =>
  sameAddress(market.vault, market.hubAsset) ? amount : fromWad(market.decimals, amount)

const bits = (word: bigint, start: number, length: number) => (word >> BigInt(start)) & ((1n << BigInt(length)) - 1n)

export const decodeReserveConfig = (configuration: bigint) => ({
  decimals: Number(bits(configuration, 48, 8)),
  active: bits(configuration, 56, 1) === 1n,
  frozen: bits(configuration, 57, 1) === 1n,
  paused: bits(configuration, 60, 1) === 1n,
  supplyCap: bits(configuration, 116, 36),
})

export const fetchLendMarkets = (chainId: number): Promise<LendMarket[]> => {
  const sodax = SODAX_CHAINS[chainId]
  if (!sodax) return Promise.resolve([])
  return cached(`markets:${chainId}`, async () => {
    const [tokens, config, reserves] = await Promise.all([
      getJson<{ symbol: string; name: string; address: string; decimals: number }[]>(
        `${BACKEND}/config/money-market/${encodeURIComponent(sodax.key)}/tokens`,
      ),
      getJson<{ supportedHubAssets: Record<string, Record<string, { asset: string; vault: string }>> }>(`${BACKEND}/config/all`),
      getJson<
        { reserveAddress: string; liquidityRate: string; variableBorrowRate: string; isFrozen?: boolean; isActive?: boolean }[]
      >(`${BACKEND}/moneymarket/asset/all`),
    ])
    const hubAssets = Object.fromEntries(
      Object.entries(config.supportedHubAssets[sodax.key] ?? {}).map(([address, entry]) => [address.toLowerCase(), entry]),
    )
    const byReserve = new Map(reserves.map((reserve) => [reserve.reserveAddress.toLowerCase(), reserve]))
    return tokens.flatMap((token) => {
      const hub = hubAssets[token.address.toLowerCase()]
      const reserve = hub && byReserve.get(hub.vault.toLowerCase())
      if (!hub || !reserve || reserve.isActive === false) return []
      return [
        {
          symbol: token.symbol,
          name: token.name,
          address: getAddress(token.address),
          decimals: token.decimals,
          hubAsset: getAddress(hub.asset),
          vault: getAddress(hub.vault),
          supplyApy: rayToApy(reserve.liquidityRate),
          borrowApy: rayToApy(reserve.variableBorrowRate),
          frozen: !!reserve.isFrozen,
        },
      ]
    })
  })
}

export const readLendPositions = async (
  chainId: number,
  safe: Address,
  hubClient: PublicClient,
  markets: LendMarket[],
): Promise<Map<string, bigint>> => {
  const sodax = SODAX_CHAINS[chainId]
  if (!sodax || markets.length === 0) return new Map()
  const hubWallet = await sodaxHubWallet(hubClient, sodax, safe)
  const vaults = [...new Map(markets.map((market) => [market.vault.toLowerCase(), market.vault])).values()]
  const reserveData = await hubClient.multicall({
    contracts: vaults.map(
      (vault) => ({ address: SODAX_LENDING_POOL, abi: poolAbi, functionName: 'getReserveData', args: [vault] }) as const,
    ),
    allowFailure: false,
  })
  const balances = await hubClient.multicall({
    contracts: reserveData.map(
      (reserve) => ({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [hubWallet] }) as const,
    ),
    allowFailure: false,
  })
  return new Map(vaults.map((vault, index) => [vault.toLowerCase(), balances[index]!]))
}

const positionHolder = (market: LendMarket, markets: LendMarket[]) => {
  const sharing = markets.filter((candidate) => sameAddress(candidate.vault, market.vault))
  return sharing.find((candidate) => !sameAddress(candidate.address, candidate.vault)) ?? sharing[0] ?? market
}

export const lendPositionOf = (market: LendMarket, positions: Map<string, bigint>, markets: LendMarket[]) =>
  sameAddress(positionHolder(market, markets).address, market.address)
    ? fromReserve(market, positions.get(market.vault.toLowerCase()) ?? 0n)
    : 0n

const formatApy = (apy: number) => `${(apy * 100).toFixed(2)}%`

const findMarket = async (input: Record<string, string>, ctx: ActionContext) => {
  const sodax = SODAX_CHAINS[ctx.chain.chainId]
  ensure(!!sodax, `${ctx.chain.name} is not supported`)
  const markets = await fetchLendMarkets(ctx.chain.chainId)
  const market = markets.find((candidate) => sameAddress(candidate.address, input.token ?? ''))
  if (!market) throw new Error('Pick a token the SODAX money market accepts on this chain')
  const amount = parseUnits((input.amount ?? '').trim() || '0', market.decimals)
  if (amount <= 0n) throw new Error('Amount must be greater than zero')
  return { sodax: sodax!, market, amount }
}

const verifyMarket = async (sodax: SodaxChain, market: LendMarket, ctx: ActionContext, hubClient: PublicClient) => {
  const verified = await verifyToken(market, sodax, ctx.client, hubClient)
  const expectedHub = sodax.isHub && market.address === zeroAddress ? WRAPPED_SONIC : verified.hub
  ensure(sameAddress(expectedHub, market.hubAsset), `${market.symbol} hub asset differs onchain (${expectedHub})`)
  const [reserves, reserve] = await Promise.all([
    hubClient.readContract({ address: SODAX_LENDING_POOL, abi: poolAbi, functionName: 'getReservesList' }),
    hubClient.readContract({ address: SODAX_LENDING_POOL, abi: poolAbi, functionName: 'getReserveData', args: [market.vault] }),
  ])
  ensure(
    reserves.some((address) => sameAddress(address, market.vault)),
    `${market.vault} is not a reserve of the SODAX money market`,
  )
  ensure(reserve.aTokenAddress !== zeroAddress, `${market.symbol} has no supply token onchain`)
  const config = decodeReserveConfig(reserve.configuration)
  ensure(config.active, `${market.symbol} is not active in the money market`)
  ensure(!config.paused, `${market.symbol} is paused in the money market`)
  const vaultIsAsset = sameAddress(market.vault, market.hubAsset)
  ensure(
    config.decimals === (vaultIsAsset ? market.decimals : 18),
    `${market.symbol} reserve has ${config.decimals} decimals onchain, expected ${vaultIsAsset ? market.decimals : 18}`,
  )
  if (!vaultIsAsset) {
    const [decimals, depositFee, withdrawalFee, , isSupported] = await hubClient.readContract({
      address: market.vault,
      abi: vaultAbi,
      functionName: 'tokenInfo',
      args: [market.hubAsset],
    })
    ensure(isSupported, `the ${market.symbol} vault does not accept ${market.hubAsset}`)
    ensure(decimals === market.decimals, `${market.symbol} vault decimals ${decimals} differ from ${market.decimals}`)
    ensure(depositFee === 0n && withdrawalFee === 0n, `the ${market.symbol} vault charges a fee`)
  }
  const hubWallet = await sodaxHubWallet(hubClient, sodax, ctx.safe.address)
  const toReserve = (amount: bigint) => (vaultIsAsset ? amount : toWad(market.decimals, amount))
  return { hubWallet, vaultIsAsset, toReserve, reserve, config, aToken: reserve.aTokenAddress, apy: rayToApy(reserve.currentLiquidityRate.toString()) }
}

const ensureSupplyRoom = async (
  market: LendMarket,
  hubClient: PublicClient,
  reserve: { aTokenAddress: Address; accruedToTreasury: bigint; liquidityIndex: bigint },
  config: ReturnType<typeof decodeReserveConfig>,
  reserveAmount: bigint,
) => {
  ensure(!config.frozen, `${market.symbol} is frozen in the money market; supplying is paused`)
  if (config.supplyCap === 0n) return
  const supplied = await hubClient.readContract({ address: reserve.aTokenAddress, abi: totalSupplyAbi, functionName: 'totalSupply' })
  const total = supplied + (reserve.accruedToTreasury * reserve.liquidityIndex) / 10n ** 27n + reserveAmount
  ensure(total <= config.supplyCap * 10n ** BigInt(config.decimals), `supplying this would exceed the ${market.symbol} supply cap`)
}

const call = (to: Address, data: Hex, value = 0n): HubCall => ({ to, value, data })

const encodeHubCalls = (calls: HubCall[]) =>
  encodeAbiParameters(sodaxHubCallsParams, [calls.map((entry) => [entry.to, entry.value, entry.data] as const)])

const toMeta = (calls: HubCall[]): MetaTx[] =>
  calls.map((entry) => ({ to: entry.to, value: entry.value.toString(), data: entry.data }))

const routeCall = (calls: HubCall[], value: bigint): MetaTx => ({
  to: HUB_USER_ROUTER,
  value: value.toString(),
  data: encodeFunctionData({
    abi: routerAbi,
    functionName: 'route',
    args: [calls.map((entry) => ({ addr: entry.to, value: entry.value, data: entry.data }))],
  }),
})

const approve = (token: Address, spender: Address, amount: bigint) =>
  call(token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }))

const relaySubmit = async (chainId: number, txHash: Hex) => {
  const sodax = SODAX_CHAINS[chainId]!
  const response = await fetch(RELAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'submit', params: { chain_id: sodax.relayId.toString(), tx_hash: txHash } }),
  })
  const json = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string }
  if (!response.ok || json.success === false) throw new Error(`SODAX relay: ${json.message ?? response.status}`)
}


const followUp = (kind: 'supply' | 'withdraw') => ({
  afterExecute: async (action: TxAction, executedTxHash: Hex, ctx: ActionContext) => {
    if (SODAX_CHAINS[ctx.chain.chainId]?.isHub)
      return { label: kind === 'supply' ? 'Supplied' : 'Withdrawn', state: 'done' as const }
    await relaySubmit(ctx.chain.chainId, executedTxHash)
    return { label: 'Relaying to the SODAX hub', state: 'progress' as const }
  },
  status: async (action: TxAction, executedTxHash: Hex, ctx: ActionContext) => {
    if (SODAX_CHAINS[ctx.chain.chainId]?.isHub)
      return { label: kind === 'supply' ? 'Supplied' : 'Withdrawn', state: 'done' as const }
    const status = (await sodaxRelayPacket(ctx.chain.chainId, executedTxHash))?.status
    if (status === 'executed')
      return kind === 'supply'
        ? { label: 'Supplied', state: 'done' as const }
        : {
            label: 'Withdrawn on the hub',
            state: 'done' as const,
            message: `The tokens are sent back to this Safe on ${ctx.chain.name}; that leg is relayed automatically.`,
          }
    if (!status)
      return { label: 'Not relayed yet', state: 'progress' as const, message: 'Press Report again if this stays for minutes.' }
    return { label: 'Relaying to the SODAX hub', state: 'progress' as const, message: status }
  },
})

const tokenFields = () => [
  { name: 'token', label: 'Token (address, 0x0…0 for the native coin)', type: 'address' as const },
  { name: 'amount', label: 'Amount', type: 'amount' as const, placeholder: '0.0' },
]

export const sodaxSupply = (getHubClient: (ctx: ActionContext) => PublicClient | undefined): ActionPlugin => ({
  id: 'sodax-supply',
  label: 'Supply (SODAX)',
  description: 'Lend a token from this Safe to the SODAX money market and earn interest.',
  supports: (chain) => !!SODAX_CHAINS[chain.chainId],
  fields: tokenFields,
  build: async (input, ctx) => {
    const { sodax, market, amount } = await findMarket(input, ctx)
    const hubClient = getHubClient(ctx)
    ensure(!!hubClient, 'a Sonic RPC is needed to verify the SODAX hub; add Sonic on Chains')
    const { hubWallet, vaultIsAsset, toReserve, reserve, config, apy } = await verifyMarket(sodax, market, ctx, hubClient!)
    const native = market.address === zeroAddress
    const wad = toReserve(amount)
    await ensureSupplyRoom(market, hubClient!, reserve, config, wad)
    const lend = [
      ...(vaultIsAsset
        ? []
        : [
            approve(market.hubAsset, market.vault, amount),
            call(market.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [market.hubAsset, amount] })),
          ]),
      approve(market.vault, SODAX_LENDING_POOL, wad),
      call(
        SODAX_LENDING_POOL,
        encodeFunctionData({ abi: poolAbi, functionName: 'supply', args: [market.vault, wad, hubWallet, 0] }),
      ),
    ]

    let calls: MetaTx[]
    if (sodax.isHub) {
      const pull = native
        ? call(WRAPPED_SONIC, encodeFunctionData({ abi: wrappedSonicAbi, functionName: 'deposit' }), amount)
        : call(
            market.address,
            encodeFunctionData({
              abi: transferFromAbi,
              functionName: 'transferFrom',
              args: [ctx.safe.address, hubWallet, amount],
            }),
          )
      calls = [
        ...(native ? [] : toMeta([approve(market.address, hubWallet, amount)])),
        routeCall([pull, ...lend], native ? amount : 0n),
      ]
    } else {
      calls = [
        ...(native ? [] : toMeta([approve(market.address, sodax.entry, amount)])),
        {
          to: sodax.entry,
          value: native ? amount.toString() : '0',
          data: encodeFunctionData({
            abi: sodaxAssetManagerAbi,
            functionName: 'transfer',
            args: [market.address, hubWallet, amount, encodeHubCalls(lend)],
          }),
        },
      ]
    }

    const amountText = `${formatTokenAmount(amount, market.decimals)} ${market.symbol}`
    return {
      calls,
      summary: `Supply ${amountText} to the SODAX money market`,
      checks: [
        `Supplies exactly ${amountText}; every approval is exactly that amount`,
        `The position is credited to this Safe's SODAX wallet ${hubWallet}`,
        `${market.symbol} is a live reserve of the SODAX lending pool ${SODAX_LENDING_POOL}`,
        'No vault deposit or withdrawal fee',
      ],
      details: [
        { label: 'You supply', value: amountText, strong: true },
        { label: 'Supply APY now', value: formatApy(apy), strong: true },
        { label: 'Held by', value: `Your Safe's SODAX wallet on Sonic, ${hubWallet.slice(0, 6)}…${hubWallet.slice(-4)}` },
        ...(sodax.isHub ? [] : [{ label: 'Route', value: `${ctx.chain.name} → SODAX hub on Sonic, relayed in about a minute` }]),
      ],
      meta: { kind: 'supply', relayId: sodax.relayId.toString() },
    }
  },
  ...followUp('supply'),
})

export const sodaxWithdraw = (getHubClient: (ctx: ActionContext) => PublicClient | undefined): ActionPlugin => ({
  id: 'sodax-withdraw',
  label: 'Withdraw (SODAX)',
  description: 'Take supplied tokens back from the SODAX money market to this Safe.',
  supports: (chain) => !!SODAX_CHAINS[chain.chainId],
  fields: tokenFields,
  build: async (input, ctx) => {
    const { sodax, market, amount } = await findMarket(input, ctx)
    const hubClient = getHubClient(ctx)
    ensure(!!hubClient, 'a Sonic RPC is needed to verify the SODAX hub; add Sonic on Chains')
    const { hubWallet, vaultIsAsset, toReserve, aToken } = await verifyMarket(sodax, market, ctx, hubClient!)
    const wad = toReserve(amount)
    const supplied = await hubClient!.readContract({
      address: aToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [hubWallet],
    })
    ensure(
      supplied >= wad,
      `only ${formatTokenAmount(fromReserve(market, supplied), market.decimals)} ${market.symbol} is supplied`,
    )
    const native = market.address === zeroAddress

    const hubCalls: HubCall[] = [
      call(
        SODAX_LENDING_POOL,
        encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [market.vault, wad, hubWallet] }),
      ),
      ...(vaultIsAsset
        ? []
        : [call(market.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [market.hubAsset, wad] }))]),
    ]

    let calls: MetaTx[]
    if (sodax.isHub) {
      hubCalls.push(
        native
          ? call(
              WRAPPED_SONIC,
              encodeFunctionData({ abi: wrappedSonicAbi, functionName: 'withdrawTo', args: [ctx.safe.address, amount] }),
            )
          : call(
              market.hubAsset,
              encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.safe.address, amount] }),
            ),
      )
      calls = [routeCall(hubCalls, 0n)]
    } else {
      const connection = sodax.connection
      ensure(!!connection, `withdrawing to ${ctx.chain.name} is not wired up yet`)
      hubCalls.push(
        call(
          HUB_ASSET_MANAGER,
          encodeFunctionData({
            abi: sodaxAssetManagerAbi,
            functionName: 'transfer',
            args: [market.hubAsset, ctx.safe.address, amount, '0x'],
          }),
        ),
      )
      calls = [
        {
          to: connection!,
          value: '0',
          data: encodeFunctionData({
            abi: connectionAbi,
            functionName: 'sendMessage',
            args: [HUB_RELAY_ID, hubWallet, encodeHubCalls(hubCalls)],
          }),
        },
      ]
    }

    const amountText = `${formatTokenAmount(amount, market.decimals)} ${market.symbol}`
    return {
      calls,
      summary: `Withdraw ${amountText} from the SODAX money market to this Safe`,
      checks: [
        `Withdraws exactly ${amountText} from this Safe's SODAX wallet ${hubWallet}`,
        `The tokens are sent to this Safe (${ctx.safe.address}) on ${ctx.chain.name}`,
        `${market.symbol} is a live reserve of the SODAX lending pool ${SODAX_LENDING_POOL}`,
      ],
      details: [
        { label: 'You withdraw', value: amountText, strong: true },
        {
          label: 'Supplied now',
          value: `${formatTokenAmount(fromReserve(market, supplied), market.decimals)} ${market.symbol}`,
        },
        ...(sodax.isHub ? [] : [{ label: 'Route', value: `SODAX hub on Sonic → ${ctx.chain.name}, relayed in a few minutes` }]),
      ],
      meta: { kind: 'withdraw', relayId: sodax.relayId.toString() },
    }
  },
  ...followUp('withdraw'),
})
