import {
  Registry,
  SODAX_HUB_CHAIN_ID,
  changeThreshold,
  matchOwners,
  nativeTransfer,
  sodaxStocks,
  sodaxSwap,
  sodaxSupply,
  sodaxWithdraw,
  type ActionContext,
  tokenTransfer,
  type ActionPlugin,
  type ChainConfig,
  type WalletPlugin,
} from '@msa/core'
import { clientFor } from './state/data.tsx'
import { ledgerPlugin } from './wallets/ledger.ts'
import { walletConnectPlugin } from './wallets/walletConnect.ts'

let knownChains: ChainConfig[] = []

export const setKnownChains = (chains: ChainConfig[]) => {
  knownChains = chains
}

export const walletRegistry = new Registry<WalletPlugin>()
  .register(walletConnectPlugin(import.meta.env.VITE_WC_PROJECT_ID ?? '', () => knownChains))
  .register(ledgerPlugin)

export const sodaxHubClient = ({ chain, client }: ActionContext) => {
  if (chain.chainId === SODAX_HUB_CHAIN_ID) return client
  const hub = knownChains.find((candidate) => candidate.chainId === SODAX_HUB_CHAIN_ID)
  return hub ? clientFor(hub) : undefined
}

export const actionRegistry = new Registry<ActionPlugin>()
  .register(nativeTransfer)
  .register(tokenTransfer)
  .register(changeThreshold)
  .register(matchOwners)
  .register(sodaxSwap(sodaxHubClient))
  .register(sodaxStocks(sodaxHubClient))
  .register(sodaxSupply(sodaxHubClient))
  .register(sodaxWithdraw(sodaxHubClient))
