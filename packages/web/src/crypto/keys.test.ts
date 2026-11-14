import { describe, expect, it } from 'vitest'
import type { CollectionName, Filter, Page, PageQuery, Storage } from '@msa/core'
import {
  decryptDoc,
  encryptDoc,
  fromB64u,
  hiddenId,
  keyCheck,
  lockDataKey,
  lockKeyFromPassphrase,
  lockKeyFromSecret,
  newDataKey,
  newRecoveryCode,
  normalizeRecoveryCode,
  recoveryParts,
  toB64u,
  unlockDataKey,
  workingKeys,
} from './keys.ts'
import { VaultLocked, createEncryptedStorage, encryptPlaintextDocs } from './encryptedStorage.ts'

const fakeServer = () => {
  const data = new Map<string, Map<string, Record<string, unknown>>>()
  const table = (collection: string) => data.get(collection) ?? data.set(collection, new Map()).get(collection)!
  const matches = (doc: Record<string, unknown>, filter?: Filter) => Object.entries(filter ?? {}).every(([field, value]) => doc[field] === value)
  const storage: Storage = {
    list: async (collection, filter) => [...table(collection).values()].filter((doc) => matches(doc, filter)) as never,
    page: async (collection, query: PageQuery) => {
      const key = (doc: Record<string, unknown>) => [...query.order.map(({ field }) => doc[field] as never), doc.id as string]
      const sorted = [...table(collection).values()]
        .filter((doc) => matches(doc, query.filter))
        .sort((a, b) => {
          const [ka, kb] = [key(a), key(b)]
          for (let index = 0; index < ka.length; index++) {
            const left = query.order[index]?.numeric ? Number(ka[index]) : ka[index]
            const right = query.order[index]?.numeric ? Number(kb[index]) : kb[index]
            if (left !== right) return (left! < right! ? -1 : 1) * (query.direction === 'asc' ? 1 : -1)
          }
          return 0
        })
      const start = query.cursor ? sorted.findIndex((doc) => doc.id === query.cursor) + 1 : 0
      const items = sorted.slice(start, start + query.limit)
      const more = start + query.limit < sorted.length
      return { items, nextCursor: more ? (items[items.length - 1]!.id as string) : null } as Page<never>
    },
    get: async (collection, id) => (table(collection).get(id) ?? null) as never,
    put: async (collection, item) => {
      table(collection).set(item.id, structuredClone(item) as never)
      return item
    },
    remove: async (collection, id) => {
      table(collection).delete(id)
    },
  }
  return { storage, raw: (collection: CollectionName) => [...table(collection).values()] }
}

describe('data key locking', () => {
  it('locks and unlocks the data key with a passkey secret and refuses another secret', async () => {
    const dataKey = newDataKey()
    const prf = crypto.getRandomValues(new Uint8Array(32))
    const wrapped = await lockDataKey(await lockKeyFromSecret(prf), dataKey)
    expect(await unlockDataKey(await lockKeyFromSecret(prf), wrapped)).toEqual(dataKey)
    await expect(unlockDataKey(await lockKeyFromSecret(crypto.getRandomValues(new Uint8Array(32))), wrapped)).rejects.toThrow(/does not unlock/)
  })

  it('locks with a passphrase', async () => {
    const dataKey = newDataKey()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const wrapped = await lockDataKey(await lockKeyFromPassphrase('correct horse battery', salt, 1000), dataKey)
    expect(await unlockDataKey(await lockKeyFromPassphrase('correct horse battery', salt, 1000), wrapped)).toEqual(dataKey)
    await expect(unlockDataKey(await lockKeyFromPassphrase('wrong horse battery', salt, 1000), wrapped)).rejects.toThrow()
  })

  it('makes recovery codes with a separate auth secret and lock key', async () => {
    const code = newRecoveryCode()
    expect(code).toMatch(/^([A-Z0-9]{5}-){4}[A-Z0-9]{5}$/)
    const dataKey = newDataKey()
    const parts = await recoveryParts(code)
    const wrapped = await lockDataKey(parts.lock, dataKey)
    const typed = await recoveryParts(code.toLowerCase().replace(/-/g, ' '))
    expect(typed.authSecret).toBe(parts.authSecret)
    expect(await unlockDataKey(typed.lock, wrapped)).toEqual(dataKey)
    expect(parts.authSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(() => normalizeRecoveryCode('ABC')).toThrow(/25 letters/)
  })

  it('round-trips base64url', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33))
    expect(fromB64u(toB64u(bytes))).toEqual(bytes)
  })
})

describe('document encryption', () => {
  it('hides ids and filter fields, keeps sort fields, and detects tampering', async () => {
    const keys = await workingKeys(newDataKey())
    const doc = { id: '137:0xabc:1', safeId: '137:0xSafe', blockNumber: '42', logIndex: 3, from: '0xdead' }
    const stored = await encryptDoc(keys, 'activity', doc)
    expect(stored.id).toBe(await hiddenId(keys, 'activity', doc.id))
    expect(JSON.stringify(stored)).not.toMatch(/0xSafe|0xdead|0xabc/)
    expect(stored).toMatchObject({ v: 1, blockNumber: '42', logIndex: 3 })
    expect(await decryptDoc(keys, 'activity', stored)).toEqual(doc)
    await expect(decryptDoc(keys, 'activity', { ...stored, id: await hiddenId(keys, 'activity', 'other') })).rejects.toThrow()
    await expect(decryptDoc(keys, 'txs', stored)).rejects.toThrow()
    const tampered = fromB64u(stored.enc)
    tampered[20] = tampered[20]! ^ 1
    await expect(decryptDoc(keys, 'activity', { ...stored, enc: toB64u(tampered) })).rejects.toThrow()
  })

  it('gives stable hidden ids per key and different ones across keys', async () => {
    const one = await workingKeys(newDataKey())
    const two = await workingKeys(newDataKey())
    expect(await hiddenId(one, 'safes', 'a')).toBe(await hiddenId(one, 'safes', 'a'))
    expect(await hiddenId(one, 'safes', 'a')).not.toBe(await hiddenId(two, 'safes', 'a'))
    expect(await hiddenId(one, 'safes', 'a')).not.toBe(await hiddenId(one, 'owners', 'a'))
    expect(await keyCheck(one)).toBe(await keyCheck(one))
  })
})

describe('encrypted storage', () => {
  it('round-trips get, list with filters, paging and removal while the server sees only ciphertext', async () => {
    const server = fakeServer()
    const keys = await workingKeys(newDataKey())
    const storage = createEncryptedStorage(server.storage, () => keys)
    await storage.put('txs', { id: '0x1', safeId: 's1', status: 'pending' } as never)
    await storage.put('txs', { id: '0x2', safeId: 's1', status: 'executed' } as never)
    await storage.put('txs', { id: '0x3', safeId: 's2', status: 'pending' } as never)
    expect(await storage.get('txs', '0x2')).toMatchObject({ status: 'executed' })
    expect((await storage.list('txs', { safeId: 's1' })).map((tx) => tx.id).sort()).toEqual(['0x1', '0x2'])
    expect((await storage.list('txs', { status: 'pending' })).map((tx) => tx.id).sort()).toEqual(['0x1', '0x3'])
    await expect(storage.list('txs', { chainId: 1 })).rejects.toThrow(/cannot be filtered/)
    expect(JSON.stringify(server.raw('txs'))).not.toMatch(/"(pending|executed|s1|s2|0x1|0x2|0x3)"/)

    for (const block of [5, 40, 300]) await storage.put('activity', { id: `a${block}`, safeId: 's1', blockNumber: String(block), logIndex: 0 } as never)
    const query = { filter: { safeId: 's1' }, order: [{ field: 'blockNumber', numeric: true }, { field: 'logIndex', numeric: true }], direction: 'desc' as const, limit: 2 }
    const first = await storage.page('activity', query)
    expect(first.items.map((item) => item.id)).toEqual(['a300', 'a40'])
    const second = await storage.page('activity', { ...query, cursor: first.nextCursor! })
    expect(second.items.map((item) => item.id)).toEqual(['a5'])

    await storage.remove('txs', '0x1')
    expect(await storage.get('txs', '0x1')).toBeNull()
  })

  it('waits out rate limits while encrypting existing documents', async () => {
    const server = fakeServer()
    const keys = await workingKeys(newDataKey())
    for (let index = 0; index < 3; index++) await server.storage.put('owners', { id: `0x${index}`, address: `0x${index}`, label: `Key ${index}` } as never)
    let puts = 0
    const waits: number[] = []
    const limited: Storage = {
      ...server.storage,
      put: async (collection, item) => {
        if (++puts === 2) throw Object.assign(new Error('Too many requests'), { status: 429, retryAfterSeconds: 7 })
        return server.storage.put(collection, item)
      },
    }
    expect(await encryptPlaintextDocs(limited, keys, { wait: async (ms) => waits.push(ms) })).toBe(3)
    expect(waits).toEqual([7000])
    expect(server.raw('owners').every((doc) => doc.v === 1)).toBe(true)
  })

  it('never lets a plaintext doc overwrite an encrypted one with the same id', async () => {
    const server = fakeServer()
    const keys = await workingKeys(newDataKey())
    const storage = createEncryptedStorage(server.storage, () => keys)
    await storage.put('owners', { id: '0xabc', label: 'Ledger', address: '0xabc' } as never)
    await server.storage.put('owners', { id: '0xabc', label: 'Ledger', address: '0xbad' } as never)
    expect(await encryptPlaintextDocs(server.storage, keys)).toBe(0)
    expect(server.raw('owners')).toHaveLength(1)
    expect(await storage.get('owners', '0xabc')).toMatchObject({ address: '0xabc' })
  })

  it('drops plaintext activity instead of encrypting it and makes Safes rescan, keeping tx follow-ups', async () => {
    const server = fakeServer()
    const keys = await workingKeys(newDataKey())
    for (let index = 0; index < 5; index++)
      await server.storage.put('activity', { id: `137:0x${index}:0`, safeId: 's1', blockNumber: String(index), logIndex: 0 } as never)
    await server.storage.put('safes', { id: 's1', name: 'Vault', scannedBlock: '999', scannedAt: 'yesterday', deployBlock: '10' } as never)
    await server.storage.put('txs', { id: '0xabc', safeId: 's1', status: 'executed', followUp: { label: 'Filled', state: 'done', at: 'now' } } as never)
    const bulk: CollectionName[] = []
    const removePlaintext = async (collection: CollectionName) => {
      bulk.push(collection)
      for (const doc of server.raw(collection)) if (!doc.enc) await server.storage.remove(collection, doc.id as string)
    }

    let puts = 0
    const flaky: Storage = {
      ...server.storage,
      put: async (collection, item) => {
        if (++puts === 2) throw new Error('network')
        return server.storage.put(collection, item)
      },
    }
    await expect(encryptPlaintextDocs(flaky, keys, { removePlaintext })).rejects.toThrow('network')
    expect(await encryptPlaintextDocs(server.storage, keys, { removePlaintext })).toBe(1)
    expect(await encryptPlaintextDocs(server.storage, keys, { removePlaintext })).toBe(0)

    expect(bulk).toEqual(['activity', 'activity', 'activity'])
    expect(server.raw('activity')).toHaveLength(0)
    const storage = createEncryptedStorage(server.storage, () => keys)
    const safe = (await storage.get('safes', 's1')) as unknown as Record<string, unknown>
    expect(safe).toMatchObject({ name: 'Vault', deployBlock: '10' })
    expect(safe.scannedBlock).toBeUndefined()
    expect(safe.scannedAt).toBeUndefined()
    expect(await storage.get('txs', '0xabc')).toMatchObject({ followUp: { label: 'Filled', state: 'done' } })
  })

  it('falls back to deleting plaintext activity one by one without a bulk endpoint', async () => {
    const server = fakeServer()
    const keys = await workingKeys(newDataKey())
    for (let index = 0; index < 3; index++) await server.storage.put('activity', { id: `a${index}`, safeId: 's1', blockNumber: '1', logIndex: index } as never)
    expect(await encryptPlaintextDocs(server.storage, keys)).toBe(0)
    expect(server.raw('activity')).toHaveLength(0)
  })

  it('refuses to work while locked', async () => {
    const storage = createEncryptedStorage(fakeServer().storage, () => null)
    await expect(storage.list('safes')).rejects.toBeInstanceOf(VaultLocked)
  })

  it('encrypts existing plaintext documents once, even after an interruption', async () => {
    const server = fakeServer()
    const keys = await workingKeys(newDataKey())
    for (let index = 0; index < 5; index++) await server.storage.put('owners', { id: `0x${index}`, address: `0x${index}`, label: `Key ${index}` } as never)
    await server.storage.put('notes', { id: 'general:1', entityType: 'general', entityId: '1', body: 'secret' } as never)

    let calls = 0
    const flaky: Storage = {
      ...server.storage,
      remove: async (collection, id) => {
        if (++calls === 3) throw new Error('network')
        return server.storage.remove(collection, id)
      },
    }
    await expect(encryptPlaintextDocs(flaky, keys)).rejects.toThrow('network')
    await encryptPlaintextDocs(server.storage, keys)
    await encryptPlaintextDocs(server.storage, keys)

    const storage = createEncryptedStorage(server.storage, () => keys)
    expect(server.raw('owners')).toHaveLength(5)
    expect(JSON.stringify(server.raw('notes'))).not.toMatch(/secret/)
    expect((await storage.list('owners')).map((owner) => owner.label).sort()).toEqual(['Key 0', 'Key 1', 'Key 2', 'Key 3', 'Key 4'])
    expect(await storage.list('notes', { entityType: 'general' })).toHaveLength(1)
  })
})
