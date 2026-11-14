import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type PublicClient } from 'viem'
import { DEFAULT_CHAINS } from '../chains.ts'
import type { DeployedSafe } from '../types.ts'
import { decodeReserveConfig, lendPositionOf, sodaxSupply, sodaxWithdraw, type LendMarket } from './sodaxLend.ts'

const SAFE = getAddress('0x1111111111111111111111111111111111111111')
const HUB_WALLET = getAddress('0x2222222222222222222222222222222222222222')
const A_TOKEN = getAddress('0x5555555555555555555555555555555555555555')
const USDC = getAddress('0x29219dd400f2Bf60E5a23d13Be72B486D4038894')
const VAULT = getAddress('0xAbbb91c0617090F0028BDC27597Cd0D038F3A833')
const WAD = 10n ** 18n

interface Reserve {
  decimals?: number
  active?: boolean
  frozen?: boolean
  paused?: boolean
  supplyCap?: bigint
  totalSupply?: bigint
}

const config = ({ decimals = 18, active = true, frozen = false, paused = false, supplyCap = 0n }: Reserve) =>
  (BigInt(decimals) << 48n) |
  ((active ? 1n : 0n) << 56n) |
  ((frozen ? 1n : 0n) << 57n) |
  ((paused ? 1n : 0n) << 60n) |
  (supplyCap << 116n) |
  (1n << 252n)

const fakeApi = () =>
  vi.fn(async (url: string) => {
    if (url.includes('/config/money-market/')) return Response.json([{ symbol: 'USDC', name: 'USD Coin', address: USDC, decimals: 6 }])
    if (url.endsWith('/config/all')) return Response.json({ supportedHubAssets: { sonic: { [USDC]: { asset: USDC, vault: VAULT } } } })
    if (url.endsWith('/moneymarket/asset/all'))
      return Response.json([{ reserveAddress: VAULT, liquidityRate: '0', variableBorrowRate: '0', isActive: true, isFrozen: false }])
    throw new Error(`unexpected ${url}`)
  })

const fakeClient = (reserve: Reserve, supplied = 100n * WAD) =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 6
      if (functionName === 'getDeployedAddress') return HUB_WALLET
      if (functionName === 'getReservesList') return [VAULT]
      if (functionName === 'getReserveData')
        return {
          configuration: config(reserve),
          liquidityIndex: 10n ** 27n,
          currentLiquidityRate: 0n,
          aTokenAddress: A_TOKEN,
          accruedToTreasury: 0n,
        }
      if (functionName === 'tokenInfo') return [6, 0n, 0n, 0n, true]
      if (functionName === 'totalSupply') return reserve.totalSupply ?? 0n
      if (functionName === 'balanceOf') return supplied
      throw new Error(`unexpected ${functionName}`)
    },
  }) as unknown as PublicClient

const run = (kind: 'supply' | 'withdraw', reserve: Reserve, amount = '10') => {
  vi.stubGlobal('fetch', fakeApi())
  const chain = DEFAULT_CHAINS.find((candidate) => candidate.chainId === 146)!
  const safe: DeployedSafe = { id: 's', name: 's', chainId: 146, status: 'deployed', address: SAFE, owners: [], threshold: 1, saltNonce: '0', createdAt: '' }
  const client = fakeClient(reserve)
  const plugin = (kind === 'supply' ? sodaxSupply : sodaxWithdraw)(() => client)
  return plugin.build({ token: USDC, amount }, { chain, safe, client })
}

afterEach(() => vi.unstubAllGlobals())

describe('lend positions', () => {
  it('counts a vault position once when several tokens share the vault', () => {
    const vault = getAddress('0x00000000000000000000000000000000000000a1')
    const market = (symbol: string, address: string): LendMarket => ({
      symbol,
      name: symbol,
      address: getAddress(address),
      decimals: 18,
      hubAsset: vault,
      vault,
      supplyApy: 0.06,
      borrowApy: 0.08,
      frozen: false,
    })
    const markets = [market('sodaUSDC', vault), market('USDC', '0x00000000000000000000000000000000000000b2')]
    const positions = new Map([[vault.toLowerCase(), 5n]])
    expect(markets.map((entry) => lendPositionOf(entry, positions, markets))).toEqual([0n, 5n])
  })
})

describe('reserve config', () => {
  it('decodes the Aave v3 bitmap of a live SODAX reserve', () => {
    const sodaUsdc = 7237005577332262213973186568751985094729963303420508151871565085374345649484n
    expect(decodeReserveConfig(sodaUsdc)).toEqual({ decimals: 18, active: true, frozen: false, paused: false, supplyCap: 1_000_000n })
  })
})

describe('sodax lend reserve checks', () => {
  it('builds an honest supply and withdraw', async () => {
    const supply = await run('supply', { supplyCap: 1_000_000n, totalSupply: 500n * WAD })
    expect(supply.summary).toBe('Supply 10 USDC to the SODAX money market')
    const withdraw = await run('withdraw', { frozen: true })
    expect(withdraw.summary).toBe('Withdraw 10 USDC from the SODAX money market to this Safe')
  })

  it.each([
    ['an inactive reserve', { active: false }, /not active/],
    ['a frozen reserve', { frozen: true }, /frozen/],
    ['a paused reserve', { paused: true }, /paused/],
    ['a full supply cap', { supplyCap: 1_000n, totalSupply: 995n * WAD }, /supply cap/],
    ['unexpected reserve decimals', { decimals: 6 }, /decimals onchain/],
  ] as const)('refuses supplying to %s', async (_, reserve, message) => {
    await expect(run('supply', reserve)).rejects.toThrow(message)
  })

  it.each([
    ['an inactive reserve', { active: false }, /not active/],
    ['a paused reserve', { paused: true }, /paused/],
  ] as const)('refuses withdrawing from %s', async (_, reserve, message) => {
    await expect(run('withdraw', reserve)).rejects.toThrow(message)
  })
})
