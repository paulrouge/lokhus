import { getAddress, keccak256, pad, parseAbi, slice, toHex, type Hex, type PublicClient } from 'viem'
import {
  getCompatibilityFallbackHandlerDeployment,
  getSafeL2SingletonDeployment,
  getSafeSingletonDeployment,
  type DeploymentFilter,
  type SingletonDeployment,
} from '@safe-global/safe-deployments'
import type { Address, ChainConfig } from '../types.ts'
import { erc20Abi, safeAbi } from './abi.ts'
import { SAFE_MULTISEND_CALL_ONLY } from './tx.ts'

export interface OnchainSafe {
  owners: Address[]
  threshold: number
  nonce: bigint
  version: string
}

export const isDeployed = async (client: PublicClient, address: Address) => {
  const code = await client.getCode({ address })
  return !!code && code !== '0x'
}

export const retry = async <T>(task: () => Promise<T>, attempts = 6, delayMs = 1500): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export const waitForDeployment = (client: PublicClient, address: Address) =>
  retry(async () => {
    if (!(await isDeployed(client, address))) throw new Error(`No contract at ${address} yet, the RPC may be behind`)
  }, 10)

export const readSafe = async (client: PublicClient, address: Address): Promise<OnchainSafe> => {
  const [owners, threshold, nonce, version] = await Promise.all([
    client.readContract({ address, abi: safeAbi, functionName: 'getOwners' }),
    client.readContract({ address, abi: safeAbi, functionName: 'getThreshold' }),
    client.readContract({ address, abi: safeAbi, functionName: 'nonce' }),
    client.readContract({ address, abi: safeAbi, functionName: 'VERSION' }),
  ])
  return { owners: owners.map((owner) => getAddress(owner)), threshold: Number(threshold), nonce, version }
}

export interface Balance {
  symbol: string
  decimals: number
  token?: Address
  amount: bigint
}

export const readBalances = async (client: PublicClient, chain: ChainConfig, address: Address): Promise<Balance[]> => {
  const native = client.getBalance({ address })
  const tokens = chain.tokens.map((token) =>
    client
      .readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
      .catch(() => 0n),
  )
  const [nativeAmount, ...tokenAmounts] = await Promise.all([native, ...tokens])
  return [
    { symbol: chain.nativeSymbol, decimals: 18, amount: nativeAmount },
    ...chain.tokens.map((token, index) => ({
      symbol: token.symbol,
      decimals: token.decimals,
      token: token.address,
      amount: tokenAmounts[index] ?? 0n,
    })),
  ]
}

export const SUPPORTED_SAFE_VERSIONS = ['1.3.0', '1.4.1']

const GUARD_SLOT = keccak256(toHex('guard_manager.guard.address'))
const FALLBACK_HANDLER_SLOT = keccak256(toHex('fallback_manager.handler.address'))
const SINGLETON_SLOT = pad('0x0', { size: 32 })
const MODULES_SENTINEL: Address = '0x0000000000000000000000000000000000000001'

const modulesAbi = parseAbi(['function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)'])

const deploymentAddresses = (
  find: (filter?: DeploymentFilter) => SingletonDeployment | undefined,
  chainId: number,
): string[] =>
  SUPPORTED_SAFE_VERSIONS.flatMap((version) => {
    const found = find({ version, network: String(chainId) })?.networkAddresses[String(chainId)]
    return (Array.isArray(found) ? found : found ? [found] : []).map((address) => address.toLowerCase())
  })

export const canonicalSafeContracts = (chainId: number) => ({
  singletons: [...deploymentAddresses(getSafeSingletonDeployment, chainId), ...deploymentAddresses(getSafeL2SingletonDeployment, chainId)],
  fallbackHandlers: deploymentAddresses(getCompatibilityFallbackHandlerDeployment, chainId),
})

const slotAddress = (value: Hex | undefined) =>
  value && BigInt(value) !== 0n ? getAddress(slice(pad(value, { size: 32 }), 12)) : null

export interface SafeHealth {
  version: string
  singleton: Address | null
  modules: Address[]
  guard: Address | null
  fallbackHandler: Address | null
  proxyProblems: string[]
  problems: string[]
}

export const readSafeHealth = async (client: PublicClient, address: Address, chainId: number): Promise<SafeHealth> => {
  const [singletonSlot, guardSlot, handlerSlot, version, [modules]] = await Promise.all([
    client.getStorageAt({ address, slot: SINGLETON_SLOT }),
    client.getStorageAt({ address, slot: GUARD_SLOT }),
    client.getStorageAt({ address, slot: FALLBACK_HANDLER_SLOT }),
    client.readContract({ address, abi: safeAbi, functionName: 'VERSION' }),
    client.readContract({ address, abi: modulesAbi, functionName: 'getModulesPaginated', args: [MODULES_SENTINEL, 10n] }),
  ])
  const canonical = canonicalSafeContracts(chainId)
  const singleton = slotAddress(singletonSlot)
  const guard = slotAddress(guardSlot)
  const fallbackHandler = slotAddress(handlerSlot)
  const proxyProblems = [
    ...(SUPPORTED_SAFE_VERSIONS.includes(version) ? [] : [`runs Safe version ${version}, only ${SUPPORTED_SAFE_VERSIONS.join(' and ')} are supported`]),
    ...(singleton && canonical.singletons.includes(singleton.toLowerCase())
      ? []
      : [`runs ${singleton ? `non-standard Safe code at ${singleton}` : 'no Safe code'}, not an official Safe singleton`]),
  ]
  const problems = [
    ...proxyProblems,
    ...modules.map((module) => `has module ${getAddress(module)} enabled, which can move funds without signatures`),
    ...(guard ? [`has transaction guard ${guard} set, which can block transactions`] : []),
    ...(fallbackHandler && !canonical.fallbackHandlers.includes(fallbackHandler.toLowerCase())
      ? [`uses non-standard fallback handler ${fallbackHandler}`]
      : []),
  ]
  return { version, singleton, modules: modules.map((module) => getAddress(module)), guard, fallbackHandler, proxyProblems, problems }
}

export const assertRealSafe = async (client: PublicClient, address: Address, chainId: number) => {
  const health = await readSafeHealth(client, address, chainId)
  if (health.proxyProblems.length) throw new Error(`Not a standard Safe: it ${health.proxyProblems.join(' and ')}`)
  return health
}

export const verifyMultiSendCallOnly = async (client: PublicClient) => {
  const code = await client.getCode({ address: SAFE_MULTISEND_CALL_ONLY.address })
  return !!code && keccak256(code) === SAFE_MULTISEND_CALL_ONLY.codeHash
}
