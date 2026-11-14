import { getAddress, toHex } from 'viem'
import { urlProblem, type ChainConfig, type EIP1193Provider, type WalletPlugin } from '@msa/core'

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: EIP1193Provider
}

const discovered = new Map<string, Eip6963Detail>()

export const discoverInjectedWallets = (onChange: () => void) => {
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail
    if (!detail?.info?.rdns || discovered.has(detail.info.rdns)) return
    discovered.set(detail.info.rdns, detail)
    onChange()
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  return () => window.removeEventListener('eip6963:announceProvider', onAnnounce)
}

const switchChain = async (provider: EIP1193Provider, chain: ChainConfig) => {
  const chainId = toHex(chain.chainId)
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
          rpcUrls: chain.rpcUrls.filter((url) => !urlProblem(url)),
          blockExplorerUrls: urlProblem(chain.explorerUrl) ? [] : [chain.explorerUrl],
        },
      ],
    })
  }
}

const toPlugin = ({ info, provider }: Eip6963Detail): WalletPlugin => ({
  id: `injected:${info.rdns}`,
  label: info.name,
  description: 'Browser extension',
  icon: info.icon,
  isAvailable: () => true,
  connect: async () => {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
    const [account] = accounts
    if (!account) throw new Error(`${info.name} returned no accounts`)
    return {
      pluginId: `injected:${info.rdns}`,
      address: getAddress(account),
      provider,
      switchChain: (chain) => switchChain(provider, chain),
      disconnect: async () => {
        await provider
          .request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
          .catch(() => undefined)
      },
    }
  },
})

export const injectedPlugins = (): WalletPlugin[] => [...discovered.values()].map(toPlugin)
