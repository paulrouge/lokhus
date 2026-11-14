import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from 'viem'
import type { ChainConfig } from './types.ts'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const toViemChain = (chain: ChainConfig): Chain =>
  defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: chain.rpcUrls } },
    blockExplorers: { default: { name: 'Explorer', url: chain.explorerUrl } },
    contracts: { multicall3: { address: MULTICALL3 } },
  })

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export const urlProblem = (value: string): string | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${value} is not a URL`
  }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null
  return `${value} must use https`
}

export const assertSecureUrl = (value: string) => {
  const problem = urlProblem(value)
  if (problem) throw new Error(problem)
}

export const createChainClient = (chain: ChainConfig): PublicClient => {
  chain.rpcUrls.forEach(assertSecureUrl)
  return createPublicClient({
    chain: toViemChain(chain),
    transport: fallback(chain.rpcUrls.map((url) => http(url))),
  })
}

export const explorerLink = (chain: ChainConfig, kind: 'address' | 'tx', value: string) =>
  urlProblem(chain.explorerUrl) ? '#' : `${chain.explorerUrl.replace(/\/$/, '')}/${kind}/${value}`

export const DEFAULT_CHAINS: ChainConfig[] = [
  {
    id: '137',
    chainId: 137,
    name: 'Polygon',
    nativeSymbol: 'POL',
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
    explorerUrl: 'https://polygonscan.com',
    tokens: [
      { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
      { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT0', decimals: 6 },
      { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18 },
    ],
    safeVersion: '1.4.1',
  },
  {
    id: '146',
    chainId: 146,
    name: 'Sonic',
    nativeSymbol: 'S',
    rpcUrls: ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com', 'https://sonic.drpc.org'],
    explorerUrl: 'https://sonicscan.org',
    tokens: [
      { address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', symbol: 'USDC', decimals: 6 },
      { address: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', symbol: 'wS', decimals: 18 },
    ],
    safeVersion: '1.4.1',
  },
  {
    id: '8453',
    chainId: 8453,
    name: 'Base',
    nativeSymbol: 'ETH',
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base'],
    explorerUrl: 'https://basescan.org',
    tokens: [
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      { address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', symbol: 'EURC', decimals: 6 },
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    ],
    safeVersion: '1.4.1',
  },
  {
    id: '1',
    chainId: 1,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
    explorerUrl: 'https://etherscan.io',
    tokens: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', symbol: 'EURC', decimals: 6 },
      { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    ],
    safeVersion: '1.4.1',
  },
]
