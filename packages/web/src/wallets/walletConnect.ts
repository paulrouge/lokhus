import { EthereumProvider } from '@walletconnect/ethereum-provider'
import { getAddress, toHex } from 'viem'
import type { ChainConfig, EIP1193Provider, WalletPlugin, WalletUi } from '@msa/core'

const ICON =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="%233b99fc"/><path d="M12.3 15.6c4.3-4.2 11.2-4.2 15.4 0l.5.5a.5.5 0 0 1 0 .8l-1.8 1.7a.3.3 0 0 1-.4 0l-.7-.7a7.6 7.6 0 0 0-10.6 0l-.8.7a.3.3 0 0 1-.4 0l-1.8-1.7a.5.5 0 0 1 0-.8l.6-.5Zm19.1 3.5 1.6 1.6a.5.5 0 0 1 0 .8l-7.2 7a.6.6 0 0 1-.8 0l-5.1-5a.1.1 0 0 0-.2 0l-5.1 5a.6.6 0 0 1-.8 0l-7.2-7a.5.5 0 0 1 0-.8l1.6-1.6a.6.6 0 0 1 .8 0l5.1 5c.1.1.2.1.2 0l5.1-5a.6.6 0 0 1 .8 0l5.1 5c.1.1.2.1.2 0l5.1-5a.6.6 0 0 1 .8 0Z" fill="white"/></svg>'

const WALLET_TIMEOUT_MS = 3 * 60 * 1000

const answerWithin = <T>(promise: Promise<T>, wallet: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${wallet} did not answer within 3 minutes. Open the app on your phone and try again; if nothing arrives, disconnect and reconnect.`,
          ),
        ),
      WALLET_TIMEOUT_MS,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

type Provider = Awaited<ReturnType<typeof EthereumProvider.init>>
type Session = NonNullable<Provider['session']>

let sharedProvider: Promise<Provider> | null = null

const providerFor = (projectId: string, chains: ChainConfig[]) => {
  sharedProvider ??= EthereumProvider.init({
    projectId,
    showQrModal: false,
    optionalChains: chains.map((candidate) => candidate.chainId) as [number, ...number[]],
    rpcMap: Object.fromEntries(chains.map((candidate) => [candidate.chainId, candidate.rpcUrls[0] ?? ''])),
    metadata: {
      name: 'Lokhus',
      description: 'Personal Safe multisig',
      url: window.location.origin,
      icons: [],
    },
  }).catch((error: unknown) => {
    sharedProvider = null
    throw error
  })
  return sharedProvider
}

const sessionAccount = (session: Session) => {
  const entry = session.namespaces.eip155?.accounts[0]
  return entry ? getAddress(entry.split(':')[2]!) : null
}

const savedSessions = (provider: Provider) =>
  provider.signer.client.session
    .getAll()
    .filter((session) => session.expiry * 1000 > Date.now() && sessionAccount(session))
    .sort((a, b) => b.expiry - a.expiry)

const pairNew = async (provider: Provider, chainIds: number[], ui: WalletUi) => {
  const showQr = (uri: string) => ui.showQr(uri)
  provider.on('display_uri', showQr)
  try {
    await provider.connect({ optionalChains: chainIds as [number, ...number[]] })
  } finally {
    provider.removeListener('display_uri', showQr)
    ui.hideQr()
  }
  if (!provider.session) throw new Error('The phone wallet did not approve the connection')
  return provider.session
}

export const walletConnectPlugin = (projectId: string, getChains: () => ChainConfig[]): WalletPlugin => ({
  id: 'walletconnect',
  label: 'WalletConnect',
  description: projectId ? 'Scan a QR code with Tangem, MetaMask mobile or any phone wallet' : 'Set VITE_WC_PROJECT_ID to enable',
  icon: ICON,
  isAvailable: () => !!projectId,
  connect: async ({ chain, ui }) => {
    const chains = getChains()
    const chainIds = [chain.chainId, ...chains.map((candidate) => candidate.chainId).filter((id) => id !== chain.chainId)]
    const provider = await providerFor(projectId, chains)
    const client = provider.signer.client

    const saved = savedSessions(provider)
    const picked = saved.length
      ? saved[
          await ui.pickAccount(
            saved.map((session) => ({ address: sessionAccount(session)!, label: session.peer.metadata.name || 'Phone wallet' })),
            { title: 'Use a connected phone wallet', newLabel: 'Connect another wallet with a QR code' },
          )
        ]
      : undefined
    const { topic } = picked ?? (await pairNew(provider, chainIds, ui))

    const current = () => {
      try {
        return client.session.get(topic)
      } catch {
        throw new Error('The phone wallet ended this connection. Disconnect and connect again.')
      }
    }
    const account = sessionAccount(current())
    if (!account) throw new Error('The phone wallet returned no accounts')

    const wallet = current().peer.metadata.name || 'The phone wallet'
    const approvedChains = () =>
      (current().namespaces.eip155?.accounts ?? []).map((entry) => Number(entry.split(':')[1])).filter((id) => Number.isSafeInteger(id))
    const approved = (chainId: number) => approvedChains().includes(chainId)
    let active = approved(chain.chainId) ? chain.chainId : (approvedChains()[0] ?? chain.chainId)

    const send = (method: string, params: unknown, chainId = active) =>
      answerWithin(
        client.request({ topic, chainId: `eip155:${approved(chainId) ? chainId : (approvedChains()[0] ?? chainId)}`, request: { method, params } }),
        wallet,
      )

    const routed: EIP1193Provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_chainId') return toHex(active)
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account]
        return send(method, params)
      },
    }

    const unknownChain = (cause: unknown) => {
      const error = cause as { code?: number; message?: string }
      return error?.code === 4902 || /unrecognized chain|not supported|unknown chain/i.test(error?.message ?? '')
    }

    const switchTo = (target: ChainConfig) => send('wallet_switchEthereumChain', [{ chainId: toHex(target.chainId) }])

    const addAndSwitch = async (target: ChainConfig) => {
      await send('wallet_addEthereumChain', [
        {
          chainId: toHex(target.chainId),
          chainName: target.name,
          nativeCurrency: { name: target.nativeSymbol, symbol: target.nativeSymbol, decimals: 18 },
          rpcUrls: target.rpcUrls.slice(0, 1),
          blockExplorerUrls: target.explorerUrl ? [target.explorerUrl] : undefined,
        },
      ])
      await switchTo(target)
    }

    return {
      pluginId: 'walletconnect',
      address: account,
      provider: routed,
      via: wallet,
      switchChain: async (target) => {
        if (active === target.chainId) return
        if (!approved(target.chainId)) {
          try {
            await switchTo(target)
          } catch (cause) {
            if (!unknownChain(cause)) throw cause
            try {
              await addAndSwitch(target)
            } catch {
              throw new Error(
                `${wallet} doesn’t have ${target.name} enabled. Turn on the ${target.name} network in ${wallet}, then disconnect and reconnect here so the connection includes it.`,
              )
            }
          }
        }
        active = target.chainId
      },
      disconnect: async () => undefined,
      forget: () => client.disconnect({ topic, reason: { code: 6000, message: 'User disconnected' } }),
    }
  },
})
