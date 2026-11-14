import Safe from '@safe-global/protocol-kit'
import { getAddress } from 'viem'
import type { Address, ChainConfig, Hex, MetaTx, SafeRecord } from '../types.ts'

export interface SafeSetup {
  owners: Address[]
  threshold: number
  saltNonce: string
}

const initPredicted = (chain: ChainConfig, setup: SafeSetup) => {
  const [rpcUrl] = chain.rpcUrls
  if (!rpcUrl) throw new Error(`Chain ${chain.name} has no RPC URL`)
  return Safe.init({
    provider: rpcUrl,
    isL1SafeSingleton: false,
    predictedSafe: {
      safeAccountConfig: { owners: setup.owners, threshold: setup.threshold },
      safeDeploymentConfig: { saltNonce: setup.saltNonce, safeVersion: chain.safeVersion },
    },
  })
}

export const validateSetup = (setup: SafeSetup): string | null => {
  if (setup.owners.length === 0) return 'Add at least one owner'
  const unique = new Set(setup.owners.map((owner) => owner.toLowerCase()))
  if (unique.size !== setup.owners.length) return 'Owners must be unique'
  if (setup.threshold < 1 || setup.threshold > setup.owners.length) return 'Threshold must be between 1 and the number of owners'
  return null
}

export const predictSafeAddress = async (chain: ChainConfig, setup: SafeSetup): Promise<Address> => {
  const kit = await initPredicted(chain, setup)
  return getAddress(await kit.getAddress())
}

export const safeDeploymentTx = async (chain: ChainConfig, setup: SafeSetup): Promise<MetaTx> => {
  const kit = await initPredicted(chain, setup)
  const tx = await kit.createSafeDeploymentTransaction()
  return { to: getAddress(tx.to), value: String(tx.value), data: tx.data as Hex }
}

export const creationSetup = async (chain: ChainConfig, safe: SafeRecord): Promise<SafeSetup | null> => {
  if (!safe.address) return null
  const candidate = safe.deploySetup ?? (safe.saltNonce ? { owners: safe.owners, threshold: safe.threshold, saltNonce: safe.saltNonce } : null)
  if (!candidate || validateSetup(candidate)) return null
  const predicted = await predictSafeAddress(chain, candidate)
  return predicted.toLowerCase() === safe.address.toLowerCase() ? candidate : null
}
