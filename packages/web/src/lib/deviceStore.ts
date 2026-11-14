export interface DeviceRecord {
  accountId: string
  deviceKey: CryptoKey
  sealed: string
  lockedAt: number | null
}

const DB_NAME = 'lokhus'
const STORE = 'device'

const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'accountId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const run = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export const readDevice = (accountId: string) => run<DeviceRecord | undefined>('readonly', (store) => store.get(accountId))

export const writeDevice = (record: DeviceRecord) => run('readwrite', (store) => store.put(record))

export const forgetDevice = (accountId: string) => run('readwrite', (store) => store.delete(accountId))

export const forgetAllDevices = () => run('readwrite', (store) => store.clear())
