import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountChoice, AccountPickOptions, ChainConfig, WalletConnection, WalletPlugin, WalletUi } from '@msa/core'
import { discoverInjectedWallets, injectedPlugins } from '../wallets/injected.ts'
import { walletRegistry } from '../plugins.ts'
import { useChains, useStorage } from './data.tsx'
import { shortAddress } from '../lib/format.ts'

interface PendingPick extends AccountPickOptions {
  choices: AccountChoice[]
  resolve(index: number): void
  reject(error: Error): void
}

interface WalletContextValue {
  connection: WalletConnection | null
  plugins: WalletPlugin[]
  modalOpen: boolean
  connectingId: string | null
  qrUri: string | null
  pick: PendingPick | null
  error: string | null
  openConnect(chain?: ChainConfig): void
  closeConnect(): void
  connect(plugin: WalletPlugin): Promise<void>
  disconnect(): Promise<void>
}

const WalletContext = createContext<WalletContextValue | null>(null)

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const storage = useStorage()
  const { chains } = useChains()
  const [connection, setConnection] = useState<WalletConnection | null>(null)
  const [injectedVersion, setInjectedVersion] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [qrUri, setQrUri] = useState<string | null>(null)
  const [pick, setPick] = useState<PendingPick | null>(null)
  const [error, setError] = useState<string | null>(null)
  const targetChain = useRef<ChainConfig | undefined>(undefined)

  useEffect(() => discoverInjectedWallets(() => setInjectedVersion((version) => version + 1)), [])

  const plugins = useMemo(() => [...injectedPlugins(), ...walletRegistry.list()], [injectedVersion])

  const ui = useMemo<WalletUi>(
    () => ({
      showQr: (uri) => setQrUri(uri),
      hideQr: () => setQrUri(null),
      pickAccount: (choices, options) =>
        new Promise<number>((resolve, reject) => {
          setPick({
            ...options,
            choices,
            resolve: (index) => {
              setPick(null)
              resolve(index)
            },
            reject: (rejection) => {
              setPick(null)
              reject(rejection)
            },
          })
        }),
    }),
    [],
  )

  const rememberOwner = useCallback(
    async (active: WalletConnection, plugin: WalletPlugin) => {
      const id = active.address.toLowerCase()
      const existing = await storage.get('owners', id)
      if (!existing) {
        const safes = await storage.list('safes')
        if (!safes.some((safe) => safe.owners.some((owner) => owner.toLowerCase() === id))) return
      }
      const connectedVia = active.via ? `${plugin.label} · ${active.via}` : plugin.label
      await storage.put('owners', {
        ...existing,
        id,
        address: active.address,
        label: existing?.label ?? `${active.via ?? plugin.label} ${shortAddress(active.address)}`,
        walletPluginId: plugin.id,
        connectedVia,
        lastConnectedAt: new Date().toISOString(),
      })
    },
    [storage],
  )

  const connect = useCallback(
    async (plugin: WalletPlugin) => {
      const chain = targetChain.current ?? chains[0]
      if (!chain) {
        setError('Add a chain first')
        return
      }
      setError(null)
      setConnectingId(plugin.id)
      try {
        await connection?.disconnect().catch(() => undefined)
        const active = await plugin.connect({ chain, ui })
        setConnection(active)
        await rememberOwner(active, plugin)
        setModalOpen(false)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setConnectingId(null)
        setQrUri(null)
      }
    },
    [chains, connection, rememberOwner, ui],
  )

  const disconnect = useCallback(async () => {
    await (connection?.forget ?? connection?.disconnect)?.().catch(() => undefined)
    setConnection(null)
  }, [connection])

  const value: WalletContextValue = {
    connection,
    plugins,
    modalOpen,
    connectingId,
    qrUri,
    pick,
    error,
    openConnect: (chain) => {
      targetChain.current = chain
      setError(null)
      setModalOpen(true)
    },
    closeConnect: () => {
      pick?.reject(new Error('Cancelled'))
      setModalOpen(false)
    },
    connect,
    disconnect,
  }

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export const useWallet = () => {
  const context = useContext(WalletContext)
  if (!context) throw new Error('WalletProvider is missing')
  return context
}
