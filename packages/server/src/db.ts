import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { FIELD_NAME, PAGE_LIMIT_MAX, type CollectionMap, type CollectionName, type Filter, type Page, type PageQuery } from '@msa/core/storage'

export const LEGACY_ACCOUNT = 'local'

export class InvalidPageQuery extends Error {}

export const pageLimit = (limit: number) => Math.min(Math.max(1, Math.floor(limit) || 1), PAGE_LIMIT_MAX)

type CursorValue = string | number | null

export const encodeCursor = (values: CursorValue[]) => Buffer.from(JSON.stringify(values)).toString('base64url')

export const decodeCursor = (cursor: string, length: number): CursorValue[] => {
  let values: unknown
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidPageQuery('Invalid cursor')
  }
  const valid =
    Array.isArray(values) &&
    values.length === length &&
    values.every((value) => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
  if (!valid) throw new InvalidPageQuery('Invalid cursor')
  return values as CursorValue[]
}

export const assertField = (field: string) => {
  if (!FIELD_NAME.test(field)) throw new InvalidPageQuery(`Invalid field: ${field}`)
}

const filterClause = (filter: Filter) => {
  const entries = Object.entries(filter)
  entries.forEach(([field]) => assertField(field))
  return {
    where: entries.map(([field]) => `AND json_extract(data, '$.${field}') = ?`).join(' '),
    values: entries.map(([, value]) => (typeof value === 'boolean' ? Number(value) : value)),
  }
}

export interface Quota {
  maxDocs: number
  maxAccountBytes: number
}

export class QuotaExceeded extends Error {}

export const tooManyDocs = (quota: Quota, collection: string) =>
  new QuotaExceeded(`You have reached the limit of ${quota.maxDocs.toLocaleString('en')} ${collection} for one account`)

export const accountFull = (quota: Quota) =>
  new QuotaExceeded(`Your account has reached its storage limit of ${Math.round(quota.maxAccountBytes / 1024 / 1024)} MB`)

export interface DocStore {
  list<C extends CollectionName>(collection: C, filter: Filter): Promise<CollectionMap[C][]>
  page<C extends CollectionName>(collection: C, query: PageQuery): Promise<Page<CollectionMap[C]>>
  get<C extends CollectionName>(collection: C, id: string): Promise<CollectionMap[C] | null>
  put<C extends CollectionName>(collection: C, item: CollectionMap[C], quota?: Quota): Promise<CollectionMap[C]>
  remove(collection: CollectionName, id: string): Promise<void>
  count(collection: CollectionName): Promise<number>
  usage(): Promise<{ bytes: number }>
  exportAll(): Promise<{ collection: string; id: string; data: unknown }[]>
  removePlaintext(collection: CollectionName): Promise<number>
}

export const openDatabase = (path: string): DatabaseSync => {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS docs (
      account TEXT NOT NULL,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (account, collection, id)
    );
    CREATE TABLE IF NOT EXISTS account_usage (
      account TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_activity_by_safe ON docs (
      account,
      collection,
      json_extract(data, '$.safeId'),
      CAST(json_extract(data, '$.blockNumber') AS INTEGER),
      CAST(json_extract(data, '$.logIndex') AS INTEGER),
      id
    );
  `)
  return db
}

export const createDocStore = (db: DatabaseSync, account: string): DocStore => {
  const getStmt = db.prepare('SELECT data FROM docs WHERE account = ? AND collection = ? AND id = ?')
  const sizeStmt = db.prepare('SELECT length(CAST(data AS BLOB)) AS n FROM docs WHERE account = ? AND collection = ? AND id = ?')
  const putStmt = db.prepare(`
    INSERT INTO docs (account, collection, id, data) VALUES (?, ?, ?, ?)
    ON CONFLICT (account, collection, id) DO UPDATE SET
      data = excluded.data,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
  const removeStmt = db.prepare('DELETE FROM docs WHERE account = ? AND collection = ? AND id = ?')
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM docs WHERE account = ? AND collection = ?')
  const usageStmt = db.prepare('SELECT bytes FROM account_usage WHERE account = ?')
  const sumStmt = db.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS n FROM docs WHERE account = ?')
  const setUsageStmt = db.prepare(
    'INSERT INTO account_usage (account, bytes) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET bytes = excluded.bytes',
  )

  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const usedBytes = () => {
    const row = usageStmt.get(account) as { bytes: number } | undefined
    if (row) return row.bytes
    const bytes = (sumStmt.get(account) as { n: number }).n
    setUsageStmt.run(account, bytes)
    return bytes
  }

  const sizeOf = (collection: CollectionName, id: string) => (sizeStmt.get(account, collection, id) as { n: number } | undefined)?.n ?? null

  return {
    async list(collection, filter) {
      const { where, values } = filterClause(filter)
      const rows = db
        .prepare(`SELECT data FROM docs WHERE account = ? AND collection = ? ${where} ORDER BY created_at, rowid`)
        .all(account, collection, ...values) as { data: string }[]
      return rows.map((row) => JSON.parse(row.data))
    },
    async page(collection, query) {
      if (query.order.length === 0) throw new InvalidPageQuery('Order by at least one field')
      query.order.forEach(({ field }) => assertField(field))
      const limit = pageLimit(query.limit)
      const { where, values } = filterClause(query.filter ?? {})
      const keys = [
        ...query.order.map(({ field, numeric }) =>
          numeric ? `CAST(json_extract(data, '$.${field}') AS INTEGER)` : `json_extract(data, '$.${field}')`,
        ),
        'id',
      ]
      const direction = query.direction === 'asc' ? 'ASC' : 'DESC'
      const after = query.cursor ? decodeCursor(query.cursor, keys.length) : null
      const cursorClause = after ? `AND (${keys.join(', ')}) ${direction === 'ASC' ? '>' : '<'} (${keys.map(() => '?').join(', ')})` : ''
      const rows = db
        .prepare(
          `SELECT data, ${keys.map((key, index) => `${key} AS k${index}`).join(', ')} FROM docs
           WHERE account = ? AND collection = ? ${where} ${cursorClause}
           ORDER BY ${keys.map((key) => `${key} ${direction}`).join(', ')} LIMIT ?`,
        )
        .all(account, collection, ...values, ...(after ?? []), limit + 1) as Record<string, string | number | null>[]
      const pageRows = rows.slice(0, limit)
      const last = pageRows[pageRows.length - 1]
      return {
        items: pageRows.map((row) => JSON.parse(row.data as string)),
        nextCursor: rows.length > limit && last ? encodeCursor(keys.map((_, index) => last[`k${index}`] ?? null)) : null,
      }
    },
    async get(collection, id) {
      const row = getStmt.get(account, collection, id) as { data: string } | undefined
      return row ? JSON.parse(row.data) : null
    },
    async put(collection, item, quota) {
      const data = JSON.stringify(item)
      const bytes = Buffer.byteLength(data)
      return transaction(() => {
        const previous = sizeOf(collection, item.id)
        const used = usedBytes()
        const next = used - (previous ?? 0) + bytes
        if (quota) {
          if (previous === null && (countStmt.get(account, collection) as { n: number }).n >= quota.maxDocs) throw tooManyDocs(quota, collection)
          if (next > quota.maxAccountBytes && next > used) throw accountFull(quota)
        }
        putStmt.run(account, collection, item.id, data)
        setUsageStmt.run(account, next)
        return item
      })
    },
    async remove(collection, id) {
      transaction(() => {
        const previous = sizeOf(collection, id)
        if (previous === null) return
        const used = usedBytes()
        removeStmt.run(account, collection, id)
        setUsageStmt.run(account, Math.max(0, used - previous))
      })
    },
    async count(collection) {
      return (countStmt.get(account, collection) as { n: number }).n
    },
    async usage() {
      return { bytes: usedBytes() }
    },
    async removePlaintext(collection) {
      return transaction(() => {
        const removed = db
          .prepare(`DELETE FROM docs WHERE account = ? AND collection = ? AND json_extract(data, '$.enc') IS NULL`)
          .run(account, collection).changes
        setUsageStmt.run(account, (sumStmt.get(account) as { n: number }).n)
        return Number(removed)
      })
    },
    async exportAll() {
      const rows = db.prepare('SELECT collection, id, data FROM docs WHERE account = ? ORDER BY collection, id').all(account) as {
        collection: string
        id: string
        data: string
      }[]
      return rows.map((row) => ({ collection: row.collection, id: row.id, data: JSON.parse(row.data) }))
    },
  }
}

export const openDocStore = (path: string, account = LEGACY_ACCOUNT): DocStore => createDocStore(openDatabase(path), account)
