import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  parseUnits,
  size,
  zeroAddress,
  type PublicClient,
} from 'viem'
import type { ActionContext, ActionPlugin } from '../plugins.ts'
import type { Address, ChainConfig, Hex, MetaTx, TxAction } from '../types.ts'
import { erc20Abi } from '../safe/abi.ts'
import { formatTokenAmount } from '../safe/activity.ts'

export const SODAX_API = 'https://api.sodax.com/v1/swaps'
export const sodaxScanUrl = (txHash: Hex) => `https://sodaxscan.com/messages/search?value=${txHash}`

const INTENTS: Address = '0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef'
const HUB_WALLET_FACTORY: Address = '0xA0ed3047D358648F2C0583B415CffCA571FDB544'
export const HUB_USER_ROUTER: Address = '0xC67C3e55c665E78b25dc9829B3Aa5af47d914733'
const SONIC_CHAIN_ID = 146
const SPOKE_CONNECTION: Address = '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD'

const HUB_ASSET_MANAGER: Address = '0x60c5681bD1DB4e50735c4cA3386005A4BA4937C0'
const ASSETS_BASE = 'https://raw.githubusercontent.com/gosodax/sodax-sdks/main/packages/assets'
const TOKEN_LOGO_BASE = `${ASSETS_BASE}/token`
const CHAIN_LOGO_FILES: Record<number, string> = {
  1: 'ethereum.png',
  10: '0xa.optimism.png',
  56: '0x38.bsc.png',
  137: '0x89.polygon.png',
  146: 'sonic.png',
  8217: '0x2019.kaia.png',
  8453: '0x2105.base.png',
  42161: '0xa4b1.arbitrum.png',
  43114: '0xa86a.avax.png',
}
const TOKEN_CACHE_MS = 10 * 60 * 1000

export interface SodaxToken {
  symbol: string
  name: string
  address: Address
  decimals: number
  stock?: boolean
}

export interface VerifiedToken extends SodaxToken {
  hub: Address
}

export interface SodaxChain {
  key: string
  relayId: bigint
  isHub: boolean
  entry: Address
  spender: Address
  connection?: Address
  stocks?: boolean
}

export const SODAX_CHAINS: Record<number, SodaxChain> = {
  1: {
    key: 'ethereum',
    relayId: 2n,
    isHub: false,
    entry: '0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4',
    spender: '0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4',
    connection: SPOKE_CONNECTION,
  },
  137: {
    key: '0x89.polygon',
    relayId: 5n,
    isHub: false,
    entry: '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
    spender: '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
    connection: SPOKE_CONNECTION,
  },
  8453: {
    key: '0x2105.base',
    relayId: 30n,
    isHub: false,
    entry: '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
    spender: '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
    connection: SPOKE_CONNECTION,
  },
  146: {
    key: 'sonic',
    relayId: 146n,
    isHub: true,
    entry: INTENTS,
    spender: INTENTS,
    stocks: true,
  },
}

export const sodaxTokenLogo = (symbol: string) =>
  `${TOKEN_LOGO_BASE}/${symbol
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.png`

export const sodaxChainLogo = (chainId: number) => {
  const file = CHAIN_LOGO_FILES[chainId]
  return file ? `${ASSETS_BASE}/chain/${file}` : undefined
}

export const sodaxIntentsAbi = parseAbi([
  'function createIntent((uint256 intentId, address creator, address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint256 deadline, bool allowPartialFill, uint256 srcChain, uint256 dstChain, bytes srcAddress, bytes dstAddress, address solver, bytes data) intent)',
])
const intentsStateAbi = parseAbi([
  'function intentStates(bytes32 intentHash) view returns (bool exists, uint256 remainingInput, uint256 receivedOutput, bool pendingPayment)',
  'event IntentFilled(bytes32 intentHash, (bool exists, uint256 remainingInput, uint256 receivedOutput, bool pendingPayment) intentState)',
  'event IntentCancelled(bytes32 intentHash)',
])
export const sodaxAssetManagerAbi = parseAbi(['function transfer(address token, bytes to, uint256 amount, bytes data) payable'])
const hubAssetManagerAbi = parseAbi(['function assets(uint256 chainId, bytes spokeAddress) view returns (address)'])
const hubWalletFactoryAbi = parseAbi(['function getDeployedAddress(uint256 chainId, bytes user) view returns (address)'])
const userRouterAbi = parseAbi(['function getDeployedAddress(address user) view returns (address)'])
export const sodaxHubCallsParams = [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }] as const

interface IntentResponse {
  tx: { to: string; value: string; data: Hex }
  intent: Record<string, unknown>
  relayData: { address: string; payload: Hex }
}

const DEFAULT_MINUTES = 5
const FILL_BUFFER_SECONDS = 600
const MAX_MINUTES = 30

const describeStatus = (status: string | undefined, userMessage?: string) => {
  switch (status) {
    case 'solved':
      return { label: 'Filled', state: 'done' as const }
    case 'failed':
      return {
        label: 'Not filled',
        state: 'failed' as const,
        message: `${userMessage ?? 'No solver filled it.'} SODAX cancels unfilled intents onchain and refunds the Safe.`,
      }
    case 'posted_execution':
      return { label: 'Waiting for a solver', state: 'progress' as const }
    case undefined:
      return { label: 'Unknown', state: 'progress' as const }
    default:
      return { label: 'Relaying to the SODAX hub', state: 'progress' as const, message: status }
  }
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${SODAX_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await response.json().catch(() => ({}))) as T & { message?: string }
  if (!response.ok) throw new Error(`SODAX ${path}: ${json.message ?? response.status}`)
  return json
}

export const ensure = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`Refused: ${message}. Nothing was created.`)
}

const decodeIntent = (chain: SodaxChain, response: IntentResponse, input: VerifiedToken, amount: bigint) => {
  const { tx } = response
  ensure(sameAddress(tx.to, chain.entry), `transaction goes to ${tx.to}, expected SODAX ${chain.entry}`)
  ensure(BigInt(tx.value) === (input.address === zeroAddress ? amount : 0n), 'unexpected native value attached')

  if (chain.isHub) {
    const call = decodeFunctionData({ abi: sodaxIntentsAbi, data: tx.data })
    ensure(call.functionName === 'createIntent', 'transaction is not createIntent')
    return { intent: call.args[0], hubWallet: undefined, payload: tx.data }
  }

  const transfer = decodeFunctionData({ abi: sodaxAssetManagerAbi, data: tx.data })
  const [token, to, transferAmount, payload] = transfer.args
  ensure(sameAddress(token, input.address), `deposit token ${token} is not ${input.symbol}`)
  ensure(transferAmount === amount, 'deposit amount differs from the swap amount')
  const [hubCalls] = decodeAbiParameters(sodaxHubCallsParams, payload)
  let intent
  for (const [target, value, data] of hubCalls) {
    ensure(value === 0n, 'hub call carries value')
    if (sameAddress(target, INTENTS)) {
      const call = decodeFunctionData({ abi: sodaxIntentsAbi, data })
      ensure(call.functionName === 'createIntent' && !intent, 'unexpected call to the Intents contract')
      intent = call.args[0]
      continue
    }
    const approve = decodeFunctionData({ abi: erc20Abi, data })
    ensure(approve.functionName === 'approve' && sameAddress(target, input.hub), `unexpected hub call to ${target}`)
    const [spender, allowance] = approve.args as readonly [Address, bigint]
    ensure(sameAddress(spender, INTENTS) && allowance === amount, 'hub approval is not exactly the swap amount to Intents')
  }
  ensure(!!intent, 'no createIntent found in the hub payload')
  ensure(size(to) === 20, 'deposit recipient is not a single hub wallet address')
  return { intent: intent!, hubWallet: getAddress(to), payload }
}

export const sodaxHubWallet = async (hubClient: PublicClient, chain: SodaxChain, safe: Address) =>
  chain.isHub
    ? hubClient.readContract({ address: HUB_USER_ROUTER, abi: userRouterAbi, functionName: 'getDeployedAddress', args: [safe] })
    : hubClient.readContract({
        address: HUB_WALLET_FACTORY,
        abi: hubWalletFactoryAbi,
        functionName: 'getDeployedAddress',
        args: [chain.relayId, safe],
      })

const tokenCache = new Map<number, { at: number; tokens: Promise<SodaxToken[]> }>()

export const fetchSodaxTokens = (chainId: number): Promise<SodaxToken[]> => {
  const sodax = SODAX_CHAINS[chainId]
  if (!sodax) return Promise.resolve([])
  const cached = tokenCache.get(chainId)
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.tokens
  const tokens = api<{ symbol: string; name: string; address: string; decimals: number; isRwa?: boolean }[]>(
    `/tokens/${encodeURIComponent(sodax.key)}`,
  ).then((list) =>
    list.map((token) => ({
      symbol: token.symbol,
      name: token.name,
      address: getAddress(token.address),
      decimals: token.decimals,
      ...(token.isRwa === true && { stock: true }),
    })),
  )
  tokens.catch(() => tokenCache.delete(chainId))
  tokenCache.set(chainId, { at: Date.now(), tokens })
  return tokens
}

const SODAX_ORACLE = 'https://api.sodax.com/v1/intent/oracle'
const PRICE_CACHE_MS = 60_000
const priceCache = new Map<number, { at: number; prices: Promise<Map<string, number>> }>()

export const fetchSodaxPrices = (chainId: number): Promise<Map<string, number>> => {
  const sodax = SODAX_CHAINS[chainId]
  if (!sodax) return Promise.resolve(new Map())
  const cached = priceCache.get(chainId)
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.prices
  const prices = fetch(SODAX_ORACLE)
    .then((response) => {
      if (!response.ok) throw new Error(`SODAX prices: HTTP ${response.status}`)
      return response.json() as Promise<{ chainId: string; address: string; priceUsd: number }[]>
    })
    .then(
      (list) =>
        new Map(
          list
            .filter((entry) => entry.chainId === String(sodax.relayId) && Number.isFinite(entry.priceUsd))
            .map((entry) => [entry.address.toLowerCase(), entry.priceUsd]),
        ),
    )
  prices.catch(() => priceCache.delete(chainId))
  priceCache.set(chainId, { at: Date.now(), prices })
  return prices
}

export const verifyToken = async (
  token: SodaxToken,
  chain: SodaxChain,
  client: PublicClient,
  hubClient: PublicClient,
): Promise<VerifiedToken> => {
  if (token.address !== zeroAddress) {
    const decimals = await client.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' })
    ensure(decimals === token.decimals, `${token.symbol} has ${decimals} decimals onchain, the API said ${token.decimals}`)
  } else {
    ensure(token.decimals === 18, `native ${token.symbol} must have 18 decimals`)
  }
  if (chain.isHub) return { ...token, hub: token.address }
  const hub = await hubClient.readContract({
    address: HUB_ASSET_MANAGER,
    abi: hubAssetManagerAbi,
    functionName: 'assets',
    args: [chain.relayId, token.address],
  })
  ensure(hub !== zeroAddress, `${token.symbol} (${token.address}) is not registered with SODAX on this chain`)
  return { ...token, hub }
}

export const listedSwapToken = (token: SodaxToken, chain: ChainConfig): SodaxToken => {
  if (token.address === zeroAddress) return { ...token, symbol: chain.nativeSymbol }
  const listed = chain.tokens.find((candidate) => sameAddress(candidate.address, token.address))
  ensure(!!listed, `${token.symbol} (${token.address}) is not on your ${chain.name} token list. Add it on the Chains page first.`)
  ensure(listed!.decimals === token.decimals, `${listed!.symbol} has ${listed!.decimals} decimals in your token list, SODAX said ${token.decimals}`)
  return { ...token, symbol: listed!.symbol }
}

const parseSwapInput = async (input: Record<string, string>, chainId: number, chainName: string) => {
  const sodax = SODAX_CHAINS[chainId]
  ensure(!!sodax, `${chainName} is not supported`)
  const tokens = await fetchSodaxTokens(chainId)
  const sell = tokens.find((token) => sameAddress(token.address, input.sell ?? ''))
  const buy = tokens.find((token) => sameAddress(token.address, input.buy ?? ''))
  if (!sell || !buy) throw new Error('Choose what to sell and what to receive')
  if (sameAddress(sell.address, buy.address)) throw new Error('Pick two different tokens')
  const amount = parseUnits((input.amount ?? '').trim() || '0', sell.decimals)
  if (amount <= 0n) throw new Error('Amount must be greater than zero')
  const slippage = Number((input.slippage ?? '').trim() || '1')
  if (!(slippage > 0 && slippage <= 5)) throw new Error('Slippage must be between 0 and 5 percent')
  const minutes = Number((input.minutes ?? '').trim() || String(DEFAULT_MINUTES))
  if (!(minutes >= 2 && minutes <= MAX_MINUTES)) throw new Error(`Validity must be between 2 and ${MAX_MINUTES} minutes`)
  return { sodax: sodax!, sell, buy, amount, slippage, minutes }
}

const fetchQuote = async (sodax: SodaxChain, sell: SodaxToken, buy: SodaxToken, amount: bigint, slippage: number) => {
  const quote = await api<{ quotedAmount: string }>('/quote', {
    tokenSrc: sell.address,
    tokenSrcChainKey: sodax.key,
    tokenDst: buy.address,
    tokenDstChainKey: sodax.key,
    amount: amount.toString(),
    quoteType: 'exact_input',
  })
  const quoted = BigInt(quote.quotedAmount)
  const minOutput = (quoted * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
  ensure(minOutput > 0n, 'SODAX quoted nothing for this swap')
  const rate = Number(formatUnits(quoted, buy.decimals)) / Number(formatUnits(amount, sell.decimals))
  return { quoted, minOutput, rate }
}

export const SODAX_DEFAULT_MINUTES = DEFAULT_MINUTES
export const SODAX_FILL_BUFFER_MINUTES = FILL_BUFFER_SECONDS / 60

export const quoteSodaxSwap = async (input: Record<string, string>, chainId: number, chainName: string) => {
  const { sodax, sell, buy, amount, slippage } = await parseSwapInput(input, chainId, chainName)
  return { sell, buy, amount, slippage, ...(await fetchQuote(sodax, sell, buy, amount, slippage)) }
}

type QuoteTerms = { sell: SodaxToken; buy: SodaxToken; amount: bigint; slippage: number }

const quoteTerms = ({ sell, buy, amount, slippage }: QuoteTerms) =>
  `${sell.address.toLowerCase()}|${buy.address.toLowerCase()}|${amount}|${slippage}`

export const sodaxSeenQuote = (quote: QuoteTerms & { minOutput: bigint }) => `${quoteTerms(quote)}|${quote.minOutput}`

const seenMinimum = (input: Record<string, string>, terms: QuoteTerms) => {
  const seen = input.seenQuote ?? ''
  const cut = seen.lastIndexOf('|')
  const minimum = seen.slice(cut + 1)
  return seen.slice(0, cut) === quoteTerms(terms) && /^\d+$/.test(minimum) ? BigInt(minimum) : 0n
}

export const sodaxSwap = (getHubClient: (ctx: ActionContext) => PublicClient | undefined): ActionPlugin => ({
  id: 'sodax-swap',
  label: 'Swap (SODAX)',
  description: 'Same-chain swap between any two tokens SODAX supports on this chain. Output always returns to this Safe.',
  supports: (chain) => !!SODAX_CHAINS[chain.chainId],
  fields: () => [
    { name: 'sell', label: 'Token to sell (address, 0x0…0 for the native coin)', type: 'address' },
    { name: 'buy', label: 'Token to receive (address)', type: 'address' },
    { name: 'amount', label: 'Amount to sell', type: 'amount', placeholder: '0.0', help: 'In units of the token you sell.' },
    {
      name: 'slippage',
      label: 'Max slippage (%)',
      type: 'text',
      placeholder: '1',
      help: 'Minimum output = quote minus this percentage.',
    },
    {
      name: 'minutes',
      label: 'Valid for (minutes)',
      type: 'text',
      placeholder: String(DEFAULT_MINUTES),
      help: 'The clock starts when you press Review. All signatures and the execution must happen before it runs out.',
    },
  ],
  preview: async (input, { chain }) => {
    if (!input.sell || !input.buy || !input.amount) return null
    const { sodax, sell, buy, amount, slippage } = await parseSwapInput(input, chain.chainId, chain.name)
    const { quoted, minOutput, rate } = await fetchQuote(sodax, sell, buy, amount, slippage)
    return [
      { label: 'You sell', value: `${formatTokenAmount(amount, sell.decimals)} ${sell.symbol}` },
      { label: 'You get (SODAX quote)', value: `≈ ${formatTokenAmount(quoted, buy.decimals)} ${buy.symbol}`, strong: true },
      { label: `At least (${slippage}% slippage)`, value: `${formatTokenAmount(minOutput, buy.decimals)} ${buy.symbol}` },
      { label: 'Rate', value: `1 ${sell.symbol} ≈ ${rate.toPrecision(6)} ${buy.symbol}` },
    ]
  },
  build: async (input, ctx) => {
    const { chain, safe } = ctx
    const parsed = await parseSwapInput(input, chain.chainId, chain.name)
    const { sodax, amount, slippage, minutes } = parsed
    const listed = { sell: listedSwapToken(parsed.sell, chain), buy: listedSwapToken(parsed.buy, chain) }
    const hubClient = getHubClient(ctx)
    ensure(!!hubClient, 'add the Sonic chain to verify tokens and the SODAX hub wallet')
    const [sell, buy] = await Promise.all([
      verifyToken(listed.sell, sodax, ctx.client, hubClient!),
      verifyToken(listed.buy, sodax, ctx.client, hubClient!),
    ])
    const quote = await fetchQuote(sodax, sell, buy, amount, slippage)
    const { quoted, rate } = quote
    const seen = seenMinimum(input, parsed)
    ensure(
      quoted >= seen,
      `SODAX now quotes ${formatTokenAmount(quoted, buy.decimals)} ${buy.symbol}, below the ${formatTokenAmount(seen, buy.decimals)} ${buy.symbol} minimum you were shown; review again`,
    )
    const minOutput = quote.minOutput > seen ? quote.minOutput : seen
    const signBefore = Math.floor(Date.now() / 1000) + Math.round(minutes * 60)
    const deadline = BigInt(signBefore + FILL_BUFFER_SECONDS)

    const response = await api<IntentResponse>('/intents', {
      srcChainKey: sodax.key,
      dstChainKey: sodax.key,
      inputToken: sell.address,
      outputToken: buy.address,
      inputAmount: amount.toString(),
      minOutputAmount: minOutput.toString(),
      deadline: deadline.toString(),
      allowPartialFill: false,
      srcAddress: safe.address,
      dstAddress: safe.address,
    })

    const { intent, hubWallet, payload } = decodeIntent(sodax, response, sell, amount)
    ensure(intent.srcChain === sodax.relayId, `source chain ${intent.srcChain} is not ${chain.name}`)
    ensure(
      intent.dstChain === sodax.relayId,
      `destination chain ${intent.dstChain} is not ${chain.name}: this would be a cross-chain swap`,
    )
    ensure(sameAddress(intent.srcAddress, safe.address), 'source address is not this Safe')
    ensure(sameAddress(intent.dstAddress, safe.address), `output goes to ${intent.dstAddress}, not this Safe`)
    ensure(sameAddress(intent.inputToken, sell.hub), `input token is not ${sell.symbol}`)
    ensure(sameAddress(intent.outputToken, buy.hub), `output token is not ${buy.symbol}`)
    ensure(intent.inputAmount === amount, 'intent input amount differs (hidden fee?)')
    ensure(intent.minOutputAmount === minOutput, 'minimum output differs from what was requested')
    ensure(intent.deadline === deadline, 'deadline differs from what was requested')
    ensure(!intent.allowPartialFill, 'partial fills enabled')
    ensure(sameAddress(intent.solver, zeroAddress), 'intent is locked to a specific solver')
    ensure(intent.data === '0x', 'intent carries extra data (fee or hook)')
    if (hubWallet) ensure(sameAddress(hubWallet, intent.creator), 'deposit goes to a different hub wallet than the intent creator')
    ensure(response.relayData?.payload?.toLowerCase() === payload.toLowerCase(), 'relay payload differs from the transaction')
    ensure(sameAddress(response.relayData.address, intent.creator), 'relay address is not the intent creator')
    const reported = response.intent
    for (const [key, value] of Object.entries(intent)) {
      ensure(
        String(reported[key]).toLowerCase() === String(value).toLowerCase(),
        `API intent field ${key} differs from the transaction`,
      )
    }

    const creator = await sodaxHubWallet(hubClient!, sodax, safe.address)
    ensure(sameAddress(creator, intent.creator), `intent creator ${intent.creator} is not this Safe's SODAX wallet ${creator}`)

    const calls = [
      ...(sell.address === zeroAddress
        ? []
        : [
            {
              to: sell.address,
              value: '0',
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [sodax.spender, amount] }),
            },
          ]),
      { to: getAddress(response.tx.to), value: BigInt(response.tx.value).toString(), data: response.tx.data },
    ]
    const sellText = `${formatTokenAmount(amount, sell.decimals)} ${sell.symbol}`
    const quoteText = `${formatTokenAmount(quoted, buy.decimals)} ${buy.symbol}`
    const minText = `${formatTokenAmount(minOutput, buy.decimals)} ${buy.symbol}`

    return {
      calls,
      summary: `SODAX swap on ${chain.name}: ${sellText} for at least ${minText}, paid to this Safe`,
      checks: [
        `Same chain: source and destination are both ${chain.name}`,
        `Output ${buy.symbol} goes to this Safe (${safe.address})`,
        `Sells exactly ${sellText}; approval is exactly that amount`,
        `Minimum output is the quote minus ${slippage}%`,
        `Signing closes after ${minutes} min; the solver then gets ${FILL_BUFFER_SECONDS / 60} more min to fill`,
        `No partner fee, no solver lock, no hooks; creator is this Safe's SODAX wallet`,
        `Calls only SODAX ${chain.name === 'Sonic' ? 'Intents' : 'AssetManager'} at ${sodax.entry}`,
      ],
      details: [
        { label: 'You sell', value: sellText, strong: true },
        { label: 'SODAX quote', value: quoteText },
        { label: `You receive at least (${slippage}% slippage)`, value: minText, strong: true },
        { label: 'Rate', value: `1 ${sell.symbol} ≈ ${rate.toPrecision(6)} ${buy.symbol}` },
        { label: 'Quoted at', value: new Date().toLocaleTimeString() },
        { label: 'Sign and execute before', value: new Date(signBefore * 1000).toLocaleTimeString(), strong: true },
        { label: 'Solver can fill until', value: new Date(Number(deadline) * 1000).toLocaleTimeString() },
        ...(buy.address === zeroAddress || chain.tokens.some((token) => sameAddress(token.address, buy.address))
          ? []
          : [
              {
                label: 'Token list',
                value: `${buy.symbol} is not on your ${chain.name} token list yet: add ${buy.address} on Chains so it shows in balances`,
              },
            ]),
      ],
      expiresAt: signBefore,
      meta: { srcChainKey: sodax.key, intent: response.intent, relayData: response.relayData.payload },
    }
  },
  afterExecute: async (action: TxAction, executedTxHash: Hex, { safe }) => {
    const meta = action.meta as { srcChainKey: string; intent: unknown; relayData: string | { payload: string } }
    await api('/submit-tx', {
      txHash: executedTxHash,
      srcChainKey: meta.srcChainKey,
      walletAddress: safe.address,
      intent: meta.intent,
      relayData: typeof meta.relayData === 'string' ? meta.relayData : (meta.relayData as { payload: string }).payload,
    })
    return { label: 'Reported to SODAX', state: 'progress' as const, url: sodaxScanUrl(executedTxHash) }
  },
  status: async (action: TxAction, executedTxHash: Hex, ctx) => {
    const url = sodaxScanUrl(executedTxHash)
    const reported = await reportedStatus(action, executedTxHash).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    )
    if (reported.value?.state === 'done' || reported.value?.state === 'failed') return { ...reported.value, url }
    const hubClient = getHubClient(ctx)
    const onchain = hubClient ? await onchainOutcome(action, executedTxHash, ctx, hubClient).catch(() => null) : null
    if (onchain) return { ...onchain, url }
    if (reported.error) throw reported.error
    return { ...reported.value!, url }
  },
})

const stockTrade = async (input: Record<string, string>, chainId: number, chainName: string) => {
  const { sell, buy } = await parseSwapInput(input, chainId, chainName)
  ensure(!!sell.stock !== !!buy.stock, 'Trade a stock token against a non-stock token')
  return { stock: (sell.stock ? sell : buy)!, side: sell.stock ? ('sell' as const) : ('buy' as const) }
}

export const sodaxStocks = (getHubClient: (ctx: ActionContext) => PublicClient | undefined): ActionPlugin => {
  const swap = sodaxSwap(getHubClient)
  return {
    ...swap,
    id: 'sodax-stocks',
    label: 'Stocks (SODAX)',
    description: 'Buy or sell tokenized US stocks and ETFs (Robinhood tokens) through SODAX. Output always returns to this Safe.',
    supports: (chain) => !!SODAX_CHAINS[chain.chainId]?.stocks,
    preview: async (input, ctx) => {
      if (!input.sell || !input.buy || !input.amount) return null
      await stockTrade(input, ctx.chain.chainId, ctx.chain.name)
      return swap.preview!(input, ctx)
    },
    build: async (input, ctx) => {
      const { stock, side } = await stockTrade(input, ctx.chain.chainId, ctx.chain.name)
      const built = await swap.build(input, ctx)
      return { ...built, summary: built.summary.replace('SODAX swap', `${side === 'buy' ? 'Buy' : 'Sell'} ${stock.symbol} stock`) }
    },
  }
}

const RELAY = 'https://api.sodax.com/v1/relay'
const INTENT_SCAN_BLOCKS = 9_999n

export const sodaxRelayPacket = async (chainId: number, txHash: Hex) => {
  const sodax = SODAX_CHAINS[chainId]!
  const response = await fetch(RELAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'get_transaction_packets', params: { chain_id: sodax.relayId.toString(), tx_hash: txHash } }),
  })
  const json = (await response.json().catch(() => ({}))) as {
    data?: { status?: string; src_tx_hash?: string; dst_tx_hash?: string }[]
  }
  return json.data?.find((entry) => sameAddress(entry.src_tx_hash ?? '', txHash))
}

const executedIntent = (sodax: SodaxChain, calls: MetaTx[]) => {
  const entry = calls.find((call) => sameAddress(call.to, sodax.entry))
  if (!entry) return null
  if (sodax.isHub) {
    const call = decodeFunctionData({ abi: sodaxIntentsAbi, data: entry.data })
    return call.functionName === 'createIntent' ? call.args[0] : null
  }
  const transfer = decodeFunctionData({ abi: sodaxAssetManagerAbi, data: entry.data })
  const [hubCalls] = decodeAbiParameters(sodaxHubCallsParams, transfer.args[3])
  const create = hubCalls.find(([target]) => sameAddress(target, INTENTS))
  return create ? decodeFunctionData({ abi: sodaxIntentsAbi, data: create[2] }).args[0] : null
}

export const sodaxIntentHash = (intent: NonNullable<ReturnType<typeof executedIntent>>) =>
  keccak256(encodeAbiParameters(sodaxIntentsAbi[0].inputs, [intent]))

const intentCreatedBlock = async (sodax: SodaxChain, chainId: number, executedTxHash: Hex, hubClient: PublicClient) => {
  const hubTxHash = sodax.isHub ? executedTxHash : ((await sodaxRelayPacket(chainId, executedTxHash))?.dst_tx_hash as Hex | undefined)
  if (!hubTxHash) return null
  return (await hubClient.getTransactionReceipt({ hash: hubTxHash })).blockNumber
}

const onchainOutcome = async (action: TxAction, executedTxHash: Hex, ctx: ActionContext, hubClient: PublicClient) => {
  const sodax = SODAX_CHAINS[ctx.chain.chainId]
  const intent = sodax && executedIntent(sodax, action.calls)
  if (!sodax || !intent) return null
  const intentHash = sodaxIntentHash(intent)
  const [exists] = await hubClient.readContract({ address: INTENTS, abi: intentsStateAbi, functionName: 'intentStates', args: [intentHash] })
  if (exists) return null
  const fromBlock = await intentCreatedBlock(sodax, ctx.chain.chainId, executedTxHash, hubClient)
  if (fromBlock === null) return null
  const latest = await hubClient.getBlockNumber({ cacheTime: 0 })
  const toBlock = fromBlock + INTENT_SCAN_BLOCKS < latest ? fromBlock + INTENT_SCAN_BLOCKS : latest
  const logs = await hubClient.getLogs({ address: INTENTS, events: intentsStateAbi.slice(1), fromBlock, toBlock })
  const outcome = logs.find((log) => log.args.intentHash?.toLowerCase() === intentHash.toLowerCase())
  if (outcome?.eventName === 'IntentFilled') return { label: 'Filled', state: 'done' as const }
  if (outcome?.eventName === 'IntentCancelled')
    return {
      label: 'Cancelled',
      state: 'failed' as const,
      message: `SODAX cancelled the intent without a fill and sends the tokens back to this Safe on ${ctx.chain.name}.`,
    }
  return null
}

const reportedStatus = async (action: TxAction, executedTxHash: Hex) => {
  const meta = action.meta as { srcChainKey: string }
  const response = await fetch(
    `${SODAX_API}/submit-tx/status?txHash=${executedTxHash}&srcChainKey=${encodeURIComponent(meta.srcChainKey)}`,
  )
  if (response.status === 404)
    return {
      label: 'Not reported to SODAX',
      state: 'needs-action' as const,
      message: 'Press Report to SODAX so a solver picks it up, or check SODAXScan in case the intent was already cancelled.',
    }
  const result = (await response.json()) as { data?: { status?: string; userMessage?: string }; message?: string }
  if (!response.ok) throw new Error(`SODAX status: ${result.message ?? response.status}`)
  return describeStatus(result.data?.status, result.data?.userMessage)
}

export const SODAX_HUB_CHAIN_ID = SONIC_CHAIN_ID
