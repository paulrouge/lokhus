import { COLLECTIONS, type CollectionMap, type CollectionName, type Filter, type PageQuery, type Storage } from '@msa/core'
import { INDEXED_FIELDS, SORT_FIELDS, decryptDoc, encryptDoc, hiddenId, hiddenValue, isEncrypted, type WorkingKeys } from './keys.ts'

export class VaultLocked extends Error {
  constructor() {
    super('Your data is locked. Unlock it with your passkey.')
  }
}

const hideFilter = async (keys: WorkingKeys, collection: CollectionName, filter: Filter | undefined) => {
  const hidden: Filter = {}
  for (const [field, value] of Object.entries(filter ?? {})) {
    if (!((INDEXED_FIELDS[collection] ?? []) as string[]).includes(field)) throw new Error(`${collection} cannot be filtered by ${field}`)
    hidden[field] = await hiddenValue(keys, collection, field, value)
  }
  return hidden
}

export const createEncryptedStorage = (raw: Storage, getKeys: () => WorkingKeys | null): Storage => {
  const keys = () => {
    const current = getKeys()
    if (!current) throw new VaultLocked()
    return current
  }
  const reveal = async <C extends CollectionName>(current: WorkingKeys, collection: C, items: unknown[]) =>
    (await Promise.all(items.filter(isEncrypted).map((item) => decryptDoc<CollectionMap[C]>(current, collection, item)))) as CollectionMap[C][]

  return {
    list: async (collection, filter) => {
      const current = keys()
      return reveal(current, collection, await raw.list(collection, await hideFilter(current, collection, filter)))
    },
    page: async (collection, query: PageQuery) => {
      const current = keys()
      for (const { field } of query.order)
        if (!((SORT_FIELDS[collection] ?? []) as string[]).includes(field)) throw new Error(`${collection} cannot be sorted by ${field}`)
      const page = await raw.page(collection, { ...query, filter: await hideFilter(current, collection, query.filter) })
      return { items: await reveal(current, collection, page.items), nextCursor: page.nextCursor }
    },
    get: async (collection, id) => {
      const current = keys()
      const stored = await raw.get(collection, await hiddenId(current, collection, id))
      return isEncrypted(stored) ? decryptDoc<CollectionMap[typeof collection]>(current, collection, stored) : null
    },
    put: async (collection, item) => {
      const current = keys()
      await raw.put(collection, (await encryptDoc(current, collection, item)) as never)
      return item
    },
    remove: async (collection, id) => {
      await raw.remove(collection, await hiddenId(keys(), collection, id))
    },
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const retryAfterMs = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status
  if (status !== 429) return null
  const seconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
  return (typeof seconds === 'number' && seconds > 0 ? seconds : 5) * 1000
}

const patiently = async <T,>(action: () => Promise<T>, wait: (ms: number) => Promise<unknown>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action()
    } catch (error) {
      const delay = retryAfterMs(error)
      if (delay === null || attempt >= 20) throw error
      await wait(delay)
    }
  }
}

const REBUILT_FROM_CHAIN: CollectionName[] = ['activity']

const forgetScan = (collection: CollectionName, item: { id: string }) => {
  if (collection !== 'safes') return item
  const { scannedBlock: _block, scannedAt: _at, ...rest } = item as { id: string; scannedBlock?: string; scannedAt?: string }
  return rest
}

export interface MigrationOptions {
  onProgress?(done: number): void
  wait?(ms: number): Promise<unknown>
  removePlaintext?(collection: CollectionName): Promise<unknown>
}

export const encryptPlaintextDocs = async (raw: Storage, keys: WorkingKeys, options: MigrationOptions = {}) => {
  const { onProgress = () => {}, wait = pause } = options
  const plaintextIds = async (collection: CollectionName, cursor?: string) =>
    patiently(() => raw.page(collection, { order: [{ field: 'id' }], direction: 'asc', limit: 200, cursor }), wait)

  for (const collection of REBUILT_FROM_CHAIN) {
    if (options.removePlaintext) {
      await patiently(() => options.removePlaintext!(collection), wait)
      continue
    }
    let cursor: string | undefined
    do {
      const page = await plaintextIds(collection, cursor)
      for (const item of page.items as unknown as { id: string }[])
        if (!isEncrypted(item)) await patiently(() => raw.remove(collection, item.id), wait)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }

  let done = 0
  for (const collection of COLLECTIONS.filter((name) => !REBUILT_FROM_CHAIN.includes(name))) {
    let cursor: string | undefined
    do {
      const page = await plaintextIds(collection, cursor)
      for (const item of page.items as unknown as { id: string }[]) {
        if (isEncrypted(item)) continue
        const stored = await encryptDoc(keys, collection, forgetScan(collection, item))
        const twin = await patiently(() => raw.get(collection, stored.id), wait)
        if (!isEncrypted(twin)) {
          await patiently(() => raw.put(collection, stored as never), wait)
          done += 1
          onProgress(done)
        }
        if (stored.id !== item.id) await patiently(() => raw.remove(collection, item.id), wait)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  return done
}
