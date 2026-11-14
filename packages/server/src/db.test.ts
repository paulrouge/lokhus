import { afterEach, describe, expect, it } from 'vitest'
import type { CollectionMap } from '@msa/core/storage'

type ActivityItem = CollectionMap['activity']
import { InvalidPageQuery, QuotaExceeded, type DocStore } from './db.ts'
import { parseListQuery } from './query.ts'
import { BACKENDS } from './testDatabases.ts'

const activity = (safeId: string, blockNumber: number, logIndex: number): ActivityItem => ({
  id: `1:0x${blockNumber.toString(16)}:${logIndex}`,
  safeId,
  chainId: 1,
  kind: 'received',
  summary: '',
  blockNumber: String(blockNumber),
  timestamp: blockNumber,
  txHash: '0x00',
  logIndex,
})

const ORDER = [
  { field: 'blockNumber', numeric: true },
  { field: 'logIndex', numeric: true },
]

const walk = async (db: DocStore, limit: number, direction: 'asc' | 'desc' = 'desc') => {
  const seen: ActivityItem[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 100; guard++) {
    const page = await db.page('activity', { filter: { safeId: 'a' }, order: ORDER, direction, limit, cursor })
    seen.push(...page.items)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  return seen
}

describe.each(BACKENDS)('$name', { timeout: 60_000 }, (backend) => {
  const store = async () => (await backend.open()).database.docStore('local')

  afterEach(() => backend.cleanup())

  describe('DocStore.page', () => {
    it('orders block numbers numerically and walks every page once', async () => {
      const db = await store()
      for (const block of [9, 10, 100, 2, 99_999_999_999]) for (const log of [0, 1, 10]) await db.put('activity', activity('a', block, log))
      await db.put('activity', activity('b', 50, 0))
      const seen = await walk(db, 4)
      expect(seen).toHaveLength(15)
      expect(seen.map((item) => `${item.blockNumber}:${item.logIndex}`).slice(0, 4)).toEqual([
        '99999999999:10',
        '99999999999:1',
        '99999999999:0',
        '100:10',
      ])
      expect(seen.every((item) => item.safeId === 'a')).toBe(true)
      expect((await walk(db, 7, 'asc')).map((item) => item.id)).toEqual([...seen].reverse().map((item) => item.id))
    })

    it('breaks ties on id so equal sort keys are neither skipped nor repeated', async () => {
      const db = await store()
      for (let index = 0; index < 9; index++) await db.put('activity', { ...activity('a', 5, 0), id: `tie-${index}` })
      const ids = (await walk(db, 2)).map((item) => item.id)
      expect(ids).toHaveLength(9)
      expect(new Set(ids).size).toBe(9)
    })

    it('caps the page size and rejects bad cursors and fields', async () => {
      const test = await backend.open()
      const db = test.database.docStore('local')
      await test.insertDocs('local', 'activity', Array.from({ length: 250 }, (_, index) => activity('a', index, 0)))
      const page = await db.page('activity', { filter: { safeId: 'a' }, order: ORDER, direction: 'desc', limit: 10_000 })
      expect(page.items).toHaveLength(200)
      expect(page.nextCursor).not.toBeNull()
      const bad = (cursor: string) => db.page('activity', { order: ORDER, direction: 'desc', limit: 5, cursor })
      await expect(bad('not-base64-json')).rejects.toThrow(InvalidPageQuery)
      await expect(bad(Buffer.from('[1,2]').toString('base64url'))).rejects.toThrow(InvalidPageQuery)
      await expect(bad(Buffer.from('[{"a":1},2,"x"]').toString('base64url'))).rejects.toThrow(InvalidPageQuery)
      await expect(db.page('activity', { order: [{ field: "x') OR 1=1 --" }], direction: 'desc', limit: 5 })).rejects.toThrow(InvalidPageQuery)
    })
  })

  describe('DocStore quotas', () => {
    const quota = { maxDocs: 3, maxAccountBytes: 10_000 }

    it('limits the number of docs per collection but allows updates', async () => {
      const db = await store()
      for (let index = 0; index < 3; index++) await db.put('notes', { id: `n${index}`, entityType: 'general', entityId: `n${index}`, body: 'x' } as never, quota)
      await expect(db.put('notes', { id: 'n3', entityType: 'general', entityId: 'n3', body: 'x' } as never, quota)).rejects.toThrow(QuotaExceeded)
      await expect(db.put('notes', { id: 'n0', entityType: 'general', entityId: 'n0', body: 'updated' } as never, quota)).resolves.toBeTruthy()
      expect(await db.count('notes')).toBe(3)
    })

    it('tracks stored bytes through updates and deletes and enforces the account limit', async () => {
      const db = await store()
      const note = (id: string, size: number) => ({ id, entityType: 'general', entityId: id, body: 'x'.repeat(size) }) as never
      await db.put('notes', note('a', 4_000), quota)
      await db.put('notes', note('b', 4_000), quota)
      await expect(db.put('notes', note('c', 4_000), quota)).rejects.toThrow(QuotaExceeded)
      const before = (await db.usage()).bytes
      await db.put('notes', note('a', 1_000), quota)
      expect((await db.usage()).bytes).toBe(before - 3_000)
      await db.remove('notes', 'b')
      await db.remove('notes', 'missing')
      expect((await db.usage()).bytes).toBeLessThan(2_000)
      await expect(db.put('notes', note('c', 4_000), quota)).resolves.toBeTruthy()
    })
  })

  it('never goes over the per-collection quota under concurrent writes', async () => {
    const db = await store()
    const quota = { maxDocs: 3, maxAccountBytes: 1_000_000 }
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => db.put('notes', { id: `n${index}`, entityType: 'general', entityId: `n${index}` } as never, quota)),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    expect(await db.count('notes')).toBe(3)
  })

  it('lists with filters in insertion order and deletes only plaintext docs', async () => {
    const db = await store()
    await db.put('txs', { id: 'b', safeId: 's1', status: 'pending' } as never)
    await db.put('txs', { id: 'a', safeId: 's1', status: 'executed' } as never)
    await db.put('txs', { id: 'c', safeId: 's2', status: 'pending', enc: 'x' } as never)
    expect((await db.list('txs', { safeId: 's1' })).map((tx) => tx.id)).toEqual(['b', 'a'])
    expect((await db.list('txs', { status: 'pending' })).map((tx) => tx.id)).toEqual(['b', 'c'])
    expect(await db.get('txs', 'missing')).toBeNull()
    expect(await db.removePlaintext('txs')).toBe(2)
    expect((await db.exportAll()).map((doc) => doc.id)).toEqual(['c'])
    expect((await db.usage()).bytes).toBe(Buffer.byteLength(JSON.stringify({ id: 'c', safeId: 's2', status: 'pending', enc: 'x' })))
  })
})

describe('parseListQuery', () => {
  it('keeps plain lists working', () => {
    expect(parseListQuery(new URLSearchParams('safeId=a'))).toEqual({ kind: 'list', filter: { safeId: 'a' } })
  })

  it('parses paging parameters', () => {
    expect(parseListQuery(new URLSearchParams('safeId=a&_order=blockNumber:n,logIndex:n&_dir=desc&_limit=50&_cursor=abc'))).toEqual({
      kind: 'page',
      query: {
        filter: { safeId: 'a' },
        order: [
          { field: 'blockNumber', numeric: true },
          { field: 'logIndex', numeric: true },
        ],
        direction: 'desc',
        limit: 50,
        cursor: 'abc',
      },
    })
  })

  it.each(['_limit=5', '_order=x&_limit=abc', '_order=x&_limit=5&_dir=up', '_order=x:s&_limit=5', '_foo=1', 'bad-field=1', '_order=a;b&_limit=5'])(
    'rejects %s',
    (query) => {
      expect(() => parseListQuery(new URLSearchParams(query))).toThrow(InvalidPageQuery)
    },
  )
})
