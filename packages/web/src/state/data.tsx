import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  createChainClient,
  type ChainConfig,
  type CollectionMap,
  type CollectionName,
  type Filter,
  type PageQuery,
  type Storage,
} from '@msa/core'
import type { PublicClient } from 'viem'

type Listener = (collection: CollectionName) => void

interface DataContextValue {
  storage: Storage
  subscribe(listener: Listener): () => void
}

const DataContext = createContext<DataContextValue | null>(null)

const withNotifications = (storage: Storage, notify: Listener): Storage => ({
  list: storage.list,
  page: storage.page,
  get: storage.get,
  put: async (collection, item) => {
    const saved = await storage.put(collection, item)
    notify(collection)
    return saved
  },
  remove: async (collection, id) => {
    await storage.remove(collection, id)
    notify(collection)
  },
})

export const DataProvider = ({ storage, children }: { storage: Storage; children: ReactNode }) => {
  const listeners = useRef(new Set<Listener>())
  const value = useMemo<DataContextValue>(
    () => ({
      storage: withNotifications(storage, (collection) => listeners.current.forEach((listener) => listener(collection))),
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
    }),
    [storage],
  )
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

const useDataContext = () => {
  const context = useContext(DataContext)
  if (!context) throw new Error('DataProvider is missing')
  return context
}

export const useStorage = () => useDataContext().storage

const useLiveQuery = <T,>(collection: CollectionName, load: () => Promise<T>, deps: unknown[]) => {
  const { subscribe } = useDataContext()
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true })
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(() => {
    loadRef
      .current()
      .then((data) => setState({ data, loading: false }))
      .catch((error: Error) => setState((previous) => ({ ...previous, error, loading: false })))
  }, [])

  useEffect(() => {
    setState((previous) => ({ ...previous, loading: true }))
    reload()
    return subscribe((changed) => changed === collection && reload())
  }, [collection, subscribe, reload, ...deps])

  return { ...state, reload }
}

export const useCollection = <C extends CollectionName>(collection: C, filter?: Filter) => {
  const storage = useStorage()
  const key = JSON.stringify(filter ?? {})
  const query = useLiveQuery(collection, () => storage.list(collection, filter), [key])
  return { ...query, items: (query.data ?? []) as CollectionMap[C][] }
}

export const usePagedCollection = <C extends CollectionName>(collection: C, query: Omit<PageQuery, 'cursor'>) => {
  const storage = useStorage()
  const { subscribe } = useDataContext()
  const key = JSON.stringify(query)
  const [state, setState] = useState<{ items: CollectionMap[C][]; nextCursor: string | null; loading: boolean; error?: Error }>({
    items: [],
    nextCursor: null,
    loading: true,
  })
  const pagesLoaded = useRef(1)
  const generation = useRef(0)

  const load = useCallback(
    async (pages: number) => {
      const run = ++generation.current
      let items: CollectionMap[C][] = []
      let cursor: string | undefined
      let nextCursor: string | null = null
      try {
        for (let index = 0; index < pages; index++) {
          const page = await storage.page(collection, { ...(JSON.parse(key) as Omit<PageQuery, 'cursor'>), cursor })
          items = [...items, ...(page.items as CollectionMap[C][])]
          nextCursor = page.nextCursor
          if (!nextCursor) break
          cursor = nextCursor
        }
        if (run === generation.current) setState({ items, nextCursor, loading: false })
      } catch (error) {
        if (run === generation.current) setState((previous) => ({ ...previous, error: error as Error, loading: false }))
      }
    },
    [storage, collection, key],
  )

  useEffect(() => {
    pagesLoaded.current = 1
    setState((previous) => ({ ...previous, loading: true }))
    void load(1)
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribe((changed) => {
      if (changed !== collection) return
      clearTimeout(timer)
      timer = setTimeout(() => void load(pagesLoaded.current), 150)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [collection, subscribe, load])

  const loadMore = useCallback(async () => {
    if (!state.nextCursor) return
    setState((previous) => ({ ...previous, loading: true }))
    const run = ++generation.current
    try {
      const page = await storage.page(collection, { ...(JSON.parse(key) as Omit<PageQuery, 'cursor'>), cursor: state.nextCursor })
      if (run !== generation.current) return
      pagesLoaded.current += 1
      setState((previous) => ({ items: [...previous.items, ...(page.items as CollectionMap[C][])], nextCursor: page.nextCursor, loading: false }))
    } catch (error) {
      if (run === generation.current) setState((previous) => ({ ...previous, error: error as Error, loading: false }))
    }
  }, [storage, collection, key, state.nextCursor])

  return { ...state, loadMore, hasMore: !!state.nextCursor }
}

export const useDoc = <C extends CollectionName>(collection: C, id: string | undefined) => {
  const storage = useStorage()
  const query = useLiveQuery(collection, async () => (id ? storage.get(collection, id) : null), [id])
  return { ...query, doc: (query.data ?? null) as CollectionMap[C] | null }
}

const clients = new Map<string, PublicClient>()

export const clientFor = (chain: ChainConfig) => {
  const key = `${chain.chainId}:${chain.rpcUrls.join(',')}`
  let client = clients.get(key)
  if (!client) {
    client = createChainClient(chain)
    clients.set(key, client)
  }
  return client
}

export const useChains = () => {
  const { items, loading } = useCollection('chains')
  const sorted = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items])
  const byId = useMemo(() => new Map(sorted.map((chain) => [chain.chainId, chain])), [sorted])
  return { chains: sorted, byId, loading }
}

export const useOwnerLabels = () => {
  const { items } = useCollection('owners')
  return useMemo(() => new Map(items.map((owner) => [owner.address.toLowerCase(), owner])), [items])
}
