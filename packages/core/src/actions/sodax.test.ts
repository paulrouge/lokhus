import { afterEach, describe, expect, it, vi } from 'vitest'
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, zeroAddress, type PublicClient } from 'viem'
import { DEFAULT_CHAINS } from '../chains.ts'
import type { DeployedSafe, Hex, TxAction } from '../types.ts'
import { erc20Abi } from '../safe/abi.ts'
import { SODAX_CHAINS, sodaxIntentHash, sodaxIntentsAbi, sodaxSeenQuote, sodaxStocks, sodaxSwap, type SodaxToken } from './sodax.ts'

const SAFE = getAddress('0x1111111111111111111111111111111111111111')
const HUB_WALLET = getAddress('0x2222222222222222222222222222222222222222')
const ATTACKER = getAddress('0x3333333333333333333333333333333333333333')
const INTENTS = '0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef'

const USDC_POLYGON = getAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')
const USDC_SONIC = getAddress('0x29219dd400f2Bf60E5a23d13Be72B486D4038894')
const TSLA = getAddress('0x8B7F46967Ed9367A70b2e046D5e26a03625d53b1')
const TOKENS: Record<
  number,
  { symbol: string; name: string; address: `0x${string}`; decimals: number; hub: `0x${string}`; isRwa?: boolean }[]
> = {
  137: [
    { symbol: 'USDC', name: 'USD Coin', address: USDC_POLYGON, decimals: 6, hub: '0xa36893ba308b332FDEbfa95916D1dF3a2e3CF8B3' },
    { symbol: 'POL', name: 'Polygon', address: zeroAddress, decimals: 18, hub: '0x9ee17486571917837210824b0d4cadfe3b324d12' },
  ],
  146: [
    { symbol: 'USDC', name: 'USD Coin', address: USDC_SONIC, decimals: 6, hub: USDC_SONIC },
    { symbol: 'S', name: 'Sonic', address: zeroAddress, decimals: 18, hub: zeroAddress },
    { symbol: 'USDX', name: 'Fake USD', address: '0x4444444444444444444444444444444444444444', decimals: 6, hub: '0x4444444444444444444444444444444444444444' },
    { symbol: 'TSLA', name: 'Tesla • Robinhood Token', address: TSLA, decimals: 18, hub: TSLA, isRwa: true },
  ],
  8453: [
    { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, hub: '0x72E852545B024ddCbc5b70C1bCBDAA025164259C' },
    { symbol: 'EURC', name: 'EURC', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6, hub: '0x228615A4e0cB4cB1A8931605301661dB2782adb8' },
    { symbol: 'ETH', name: 'Ether', address: zeroAddress, decimals: 18, hub: '0x70178089842Be7f8E4726b33F0D1569dB8021fAa' },
  ],
  1: [
    { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, hub: '0x46BD0cE9b2b455ac4377cD142eCB8B719715197D' },
    { symbol: 'EURC', name: 'EURC', address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', decimals: 6, hub: '0x0e5BF34DFd21c45934C342c3BC6Bc76bF467B365' },
    { symbol: 'ETH', name: 'Ether', address: zeroAddress, decimals: 18, hub: '0xaeAfA26E43F46CD83efe89B1E57C858eB5685a24' },
  ],
}
const token = (chainId: number, address: string) => TOKENS[chainId]!.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase())!

const intentsAbi = parseAbi([
  'function createIntent((uint256 intentId, address creator, address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint256 deadline, bool allowPartialFill, uint256 srcChain, uint256 dstChain, bytes srcAddress, bytes dstAddress, address solver, bytes data) intent)',
])
const assetManagerAbi = parseAbi(['function transfer(address token, bytes to, uint256 amount, bytes data) payable'])

type Intent = {
  intentId: bigint
  creator: `0x${string}`
  inputToken: `0x${string}`
  outputToken: `0x${string}`
  inputAmount: bigint
  minOutputAmount: bigint
  deadline: bigint
  allowPartialFill: boolean
  srcChain: bigint
  dstChain: bigint
  srcAddress: Hex
  dstAddress: Hex
  solver: `0x${string}`
  data: Hex
}

type Tamper = {
  intent?: Partial<Intent>
  to?: string
  reportedIntent?: Partial<Record<string, string>>
  hubWallet?: `0x${string}`
  relayPayload?: Hex
  relayAddress?: `0x${string}`
  onchainDecimals?: number
  unregistered?: boolean
  quotedAmount?: string
}

const fakeApi = (chainId: number, tamper: Tamper = {}) =>
  vi.fn(async (url: string, init?: { body?: string }) => {
    const sodax = SODAX_CHAINS[chainId]!
    const body = init?.body ? JSON.parse(init.body) : {}
    if (url.includes('/tokens/')) return Response.json(TOKENS[chainId]!.map(({ hub: _, ...rest }) => rest))
    if (url.endsWith('/quote')) return Response.json({ quotedAmount: tamper.quotedAmount ?? '1000000000000000000' })
    const sell = token(chainId, body.inputToken)
    const buy = token(chainId, body.outputToken)
    const intent: Intent = {
      intentId: 42n,
      creator: HUB_WALLET,
      inputToken: sell.hub,
      outputToken: buy.hub,
      inputAmount: BigInt(body.inputAmount),
      minOutputAmount: BigInt(body.minOutputAmount),
      deadline: BigInt(body.deadline),
      allowPartialFill: false,
      srcChain: sodax.relayId,
      dstChain: sodax.relayId,
      srcAddress: body.srcAddress.toLowerCase(),
      dstAddress: body.dstAddress.toLowerCase(),
      solver: zeroAddress,
      data: '0x',
      ...tamper.intent,
    }
    const createIntent = encodeFunctionData({ abi: intentsAbi, functionName: 'createIntent', args: [intent] })
    const amount = BigInt(body.inputAmount)
    const hubPayload = encodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
      [
        [
          [sell.hub, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [INTENTS, amount] })],
          [INTENTS, 0n, createIntent],
        ],
      ],
    )
    const data = sodax.isHub
      ? createIntent
      : encodeFunctionData({
          abi: assetManagerAbi,
          functionName: 'transfer',
          args: [
            sell.address,
            tamper.hubWallet ?? HUB_WALLET,
            amount,
            hubPayload,
          ],
        })
    const reported = Object.fromEntries(Object.entries(intent).map(([key, value]) => [key, String(value)]))
    return Response.json({
      tx: { from: SAFE, to: tamper.to ?? sodax.entry, value: sell.address === zeroAddress ? amount.toString() : '0', data },
      intent: { ...reported, ...tamper.reportedIntent },
      relayData: { address: tamper.relayAddress ?? HUB_WALLET, payload: tamper.relayPayload ?? (sodax.isHub ? data : hubPayload) },
    })
  })

const fakeClient = (chainId: number, tamper: Tamper = {}) =>
  ({
    readContract: async ({ functionName, address, args }: { functionName: string; address: string; args?: readonly unknown[] }) => {
      if (functionName === 'getDeployedAddress') return HUB_WALLET
      if (functionName === 'decimals') return tamper.onchainDecimals ?? token(chainId, address).decimals
      if (functionName === 'assets') return tamper.unregistered ? zeroAddress : token(chainId, args![1] as string).hub
      throw new Error(`unexpected ${functionName}`)
    },
  }) as unknown as PublicClient

const build = (
  chainId: number,
  sellSymbol: string,
  buySymbol: string,
  tamper?: Tamper,
  extra: Record<string, string> = {},
  plugin = sodaxSwap,
) => {
  vi.stubGlobal('fetch', fakeApi(chainId, tamper))
  const defaults = DEFAULT_CHAINS.find((candidate) => candidate.chainId === chainId)!
  const chain = chainId === 146 ? { ...defaults, tokens: [...defaults.tokens, { address: TSLA, symbol: 'TSLA', decimals: 18 }] } : defaults
  const safe: DeployedSafe = { id: 's', name: 's', chainId, status: 'deployed', address: SAFE, owners: [], threshold: 1, saltNonce: '0', createdAt: '' }
  const client = fakeClient(chainId, tamper)
  const find = (symbol: string) => TOKENS[chainId]!.find((candidate) => candidate.symbol === symbol)!.address
  return plugin(() => client).build(
    { sell: find(sellSymbol), buy: find(buySymbol), amount: '10', slippage: '1', minutes: '5', ...extra },
    { chain, safe, client },
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('sodax token list', () => {
  it('refuses tokens that are not on the chain token list', async () => {
    await expect(build(146, 'S', 'USDX')).rejects.toThrow(/not on your Sonic token list/)
  })
})

describe('sodax stocks', () => {
  it('buys and sells a stock token against a non-stock token', async () => {
    expect((await build(146, 'USDC', 'TSLA', {}, {}, sodaxStocks)).summary).toMatch(/^Buy TSLA stock on Sonic/)
    expect((await build(146, 'TSLA', 'S', {}, {}, sodaxStocks)).summary).toMatch(/^Sell TSLA stock on Sonic/)
  })

  it('refuses a trade without a stock token', async () => {
    await expect(build(146, 'USDC', 'S', {}, {}, sodaxStocks)).rejects.toThrow(/stock token against a non-stock/)
  })

  it('is offered only on chains with SODAX stocks', () => {
    const plugin = sodaxStocks(() => undefined)
    expect(DEFAULT_CHAINS.filter((chain) => plugin.supports(chain)).map((chain) => chain.chainId)).toEqual([146])
  })
})

describe('sodax swap verification', () => {
  it('accepts an honest same-chain swap on Polygon and Sonic', async () => {
    const polygon = await build(137, 'USDC', 'POL')
    expect(polygon.calls).toHaveLength(2)
    expect(polygon.summary).toContain('at least 0.99 POL')
    expect(polygon.expiresAt! - Date.now() / 1000).toBeGreaterThan(290)
    expect(polygon.meta?.relayData).toMatch(/^0x[0-9a-f]+$/)
    const sonic = await build(146, 'S', 'USDC')
    expect(sonic.calls).toHaveLength(1)
    expect(sonic.calls[0]!.value).toBe('10000000000000000000')
  })

  it.each([
    [8453, 'EURC', 'USDC'],
    [8453, 'ETH', 'EURC'],
    [1, 'EURC', 'USDC'],
    [1, 'USDC', 'EURC'],
  ] as const)('accepts an honest swap on chain %i: %s to %s', async (chainId, sell, buy) => {
    const built = await build(chainId, sell, buy)
    expect(built.calls).toHaveLength(sell === 'ETH' ? 1 : 2)
    expect(built.calls.at(-1)!.to).toBe(SODAX_CHAINS[chainId]!.entry)
    expect(built.summary).toMatch(new RegExp(`at least [\\d,.]+ ${buy}, paid to this Safe`))
  })

  it('refuses a deposit to the Polygon hub wallet on Base', async () => {
    await expect(build(8453, 'EURC', 'USDC', { intent: { srcChain: 5n } })).rejects.toThrow()
  })

  it.each([
    ['cross-chain destination', 137, { intent: { dstChain: 146n } }, /cross-chain/],
    ['cross-chain on Sonic', 146, { intent: { dstChain: 5n } }, /cross-chain/],
    ['output to someone else', 137, { intent: { dstAddress: ATTACKER.toLowerCase() as Hex } }, /not this Safe/],
    ['wrong output token', 146, { intent: { outputToken: ATTACKER } }, /output token/],
    ['lower minimum output', 137, { intent: { minOutputAmount: 1n } }, /minimum output/],
    ['hidden fee', 146, { intent: { inputAmount: 9_000_000n } }, /input amount/],
    ['solver lock', 146, { intent: { solver: ATTACKER } }, /solver/],
    ['hook data', 137, { intent: { data: '0x1234' as Hex } }, /extra data/],
    ['unexpected contract', 137, { to: ATTACKER }, /expected SODAX/],
    ['foreign intent creator', 146, { intent: { creator: ATTACKER } }, /creator/],
    ['deposit to another hub wallet', 137, { hubWallet: ATTACKER }, /hub wallet/],
    ['API reports a different intent', 137, { reportedIntent: { dstChain: '146' } }, /differs from the transaction/],
    ['relay payload swapped', 137, { relayPayload: '0xdeadbeef' }, /relay payload/],
    ['relay to another wallet', 146, { relayAddress: ATTACKER }, /relay address/],
    ['API lies about decimals', 137, { onchainDecimals: 18 }, /decimals onchain/],
    ['token unknown to the SODAX hub', 137, { unregistered: true }, /not registered/],
    ['hub wallet hidden behind a padded recipient', 137, { hubWallet: concat([ATTACKER, HUB_WALLET]) }, /single hub wallet/],
    ['zero quote', 146, { quotedAmount: '0' }, /quoted nothing/],
  ] as const)('refuses %s', async (_, chainId, tamper, message) => {
    await expect(build(chainId, 'USDC', chainId === 137 ? 'POL' : 'S', tamper as Tamper)).rejects.toThrow(message)
  })
})

describe('sodax quote floor', () => {
  const polygon = TOKENS[137]!
  const usdc = polygon.find((candidate) => candidate.symbol === 'USDC')!
  const pol = polygon.find((candidate) => candidate.symbol === 'POL')!
  const seen = (minOutput: bigint, amount = 10_000_000n) =>
    sodaxSeenQuote({ sell: usdc as SodaxToken, buy: pol as SodaxToken, amount, slippage: 1, minOutput })

  it('refuses when SODAX quotes less at build than the minimum the user was shown', async () => {
    await expect(build(137, 'USDC', 'POL', { quotedAmount: '500000000000000000' }, { seenQuote: seen(990_000_000_000_000_000n) })).rejects.toThrow(
      /below the 0\.99 POL minimum you were shown/,
    )
  })

  it('keeps the minimum the user was shown when the new quote allows it', async () => {
    const built = await build(137, 'USDC', 'POL', {}, { seenQuote: seen(995_000_000_000_000_000n) })
    expect(built.summary).toContain('at least 0.995 POL')
  })

  it('ignores a shown quote for different terms', async () => {
    const built = await build(137, 'USDC', 'POL', { quotedAmount: '500000000000000000' }, { seenQuote: seen(990_000_000_000_000_000n, 1n) })
    expect(built.summary).toContain('at least 0.495 POL')
  })
})

describe('sodax swap status onchain', () => {
  const POLYGON_INTENT = {
    intentId: 42n,
    creator: HUB_WALLET,
    inputToken: getAddress('0x9Ee17486571917837210824b0d4CAdfe3B324D12'),
    outputToken: getAddress('0xa36893ba308b332FDEbfa95916D1dF3a2e3CF8B3'),
    inputAmount: 10000000000000000000n,
    minOutputAmount: 1000000n,
    deadline: 1800000000n,
    allowPartialFill: false,
    srcChain: 5n,
    dstChain: 5n,
    srcAddress: '0x1111111111111111111111111111111111111111',
    dstAddress: '0x1111111111111111111111111111111111111111',
    solver: zeroAddress,
    data: '0x',
  } as const
  const SONIC_INTENT = { ...POLYGON_INTENT, srcChain: 146n, dstChain: 146n, srcAddress: SAFE, dstAddress: SAFE } as const
  const EXECUTED: Hex = `0x${'aa'.repeat(32)}`
  const sonic = DEFAULT_CHAINS.find((chain) => chain.chainId === 146)!
  const safe: DeployedSafe = { id: 's', name: 's', chainId: 146, status: 'deployed', address: SAFE, owners: [], threshold: 1, saltNonce: '0', createdAt: '' }
  const action: TxAction = {
    pluginId: 'sodax-swap',
    input: {},
    summary: '',
    calls: [{ to: INTENTS, value: '0', data: encodeFunctionData({ abi: sodaxIntentsAbi, functionName: 'createIntent', args: [SONIC_INTENT] }) }],
    meta: { srcChainKey: 'sonic' },
  }
  const hubWith = (exists: boolean, logs: { eventName: string; args: { intentHash: Hex } }[]) =>
    ({
      readContract: async () => [exists, 0n, 0n, false],
      getTransactionReceipt: async () => ({ blockNumber: 100n }),
      getBlockNumber: async () => 2_000n,
      getLogs: async () => logs,
    }) as unknown as PublicClient
  const statusWith = (hub: PublicClient) => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    return sodaxSwap(() => hub).status!(action, EXECUTED, { chain: sonic, safe, client: hub })
  }

  afterEach(() => vi.unstubAllGlobals())

  it('hashes an intent the way the Intents contract does', () => {
    expect(sodaxIntentHash(POLYGON_INTENT)).toBe('0xd72cd7e22dcdc5112a2444b44d74edd9a53c1b3e7b23c0d90b63798d4e3a8c65')
  })

  it('reports an intent cancelled onchain', async () => {
    const hash = sodaxIntentHash(SONIC_INTENT)
    const result = await statusWith(hubWith(false, [{ eventName: 'IntentCancelled', args: { intentHash: hash } }]))
    expect(result).toMatchObject({ label: 'Cancelled', state: 'failed' })
  })

  it('reports an intent filled onchain', async () => {
    const hash = sodaxIntentHash(SONIC_INTENT)
    const result = await statusWith(hubWith(false, [{ eventName: 'IntentFilled', args: { intentHash: hash } }]))
    expect(result).toMatchObject({ label: 'Filled', state: 'done' })
  })

  it('ignores outcomes of other intents and open intents', async () => {
    const other: Hex = `0x${'cc'.repeat(32)}`
    expect(await statusWith(hubWith(false, [{ eventName: 'IntentCancelled', args: { intentHash: other } }]))).toMatchObject({
      state: 'needs-action',
    })
    const hash = sodaxIntentHash(SONIC_INTENT)
    expect(await statusWith(hubWith(true, [{ eventName: 'IntentCancelled', args: { intentHash: hash } }]))).toMatchObject({
      state: 'needs-action',
    })
  })
})
