import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { randomBytes } from 'node:crypto'
import { openDatabase } from './db.ts'
import { sqliteDatabase, type Database } from './database.ts'

export interface TestDatabase {
  database: Database
  count(table: string, where?: Record<string, string>): Promise<number>
  all(table: string): Promise<Record<string, unknown>[]>
  insertDoc(account: string, collection: string, id: string, data: unknown): Promise<void>
  insertDocs(account: string, collection: string, items: { id: string }[]): Promise<void>
}

export interface TestBackend {
  name: string
  open(): Promise<TestDatabase>
  cleanup(): Promise<void>
}

const TABLE = /^[a-z_]+$/

const whereClause = (where: Record<string, string>, placeholder: (index: number) => string) => {
  const entries = Object.entries(where)
  entries.forEach(([column]) => {
    if (!TABLE.test(column)) throw new Error(`Bad column ${column}`)
  })
  return {
    sql: entries.length ? `WHERE ${entries.map(([column], index) => `${column} = ${placeholder(index)}`).join(' AND ')}` : '',
    values: entries.map(([, value]) => value),
  }
}

const sqliteBackend = (): TestBackend => {
  const dirs: string[] = []
  return {
    name: 'sqlite',
    async open() {
      const dir = mkdtempSync(join(tmpdir(), 'lokhus-test-'))
      dirs.push(dir)
      const db = openDatabase(join(dir, 'app.db'))
      const database = sqliteDatabase(db)
      return {
        database,
        async count(table, where = {}) {
          if (!TABLE.test(table)) throw new Error(`Bad table ${table}`)
          const { sql, values } = whereClause(where, () => '?')
          return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${sql}`).get(...values) as { n: number }).n
        },
        async all(table) {
          if (!TABLE.test(table)) throw new Error(`Bad table ${table}`)
          return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
        },
        async insertDoc(account, collection, id, data) {
          db.prepare('INSERT INTO docs (account, collection, id, data) VALUES (?, ?, ?, ?)').run(account, collection, id, JSON.stringify(data))
        },
        async insertDocs(account, collection, items) {
          const insert = db.prepare('INSERT INTO docs (account, collection, id, data) VALUES (?, ?, ?, ?)')
          for (const item of items) insert.run(account, collection, item.id, JSON.stringify(item))
        },
      }
    },
    async cleanup() {
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    },
  }
}

const envFile = () => {
  const file = resolve(import.meta.dirname, '../../../.env')
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
}

const setting = (name: string, file: Record<string, string | undefined>) => (process.env[name] ?? file[name])?.trim() || null

const postgresBackend = (url: string): TestBackend => {
  const opened: { database: Database; schema: string }[] = []
  return {
    name: 'postgres',
    async open() {
      const { openPostgres, withPostgresPool } = await import('./postgres.ts')
      const schema = `lokhus_test_${randomBytes(6).toString('hex')}`
      await withPostgresPool(url, (pool) => pool.query(`CREATE SCHEMA ${schema}`))
      const database = await openPostgres(url, { schema, max: 4 })
      opened.push({ database, schema })
      const query = async (sql: string, values: unknown[] = []) =>
        withPostgresPool(url, async (pool) => {
          const client = await pool.connect()
          try {
            await client.query(`SET search_path TO ${schema}`)
            return (await client.query(sql, values)).rows as Record<string, unknown>[]
          } finally {
            client.release()
          }
        })
      return {
        database,
        async count(table, where = {}) {
          if (!TABLE.test(table)) throw new Error(`Bad table ${table}`)
          const { sql, values } = whereClause(where, (index) => `$${index + 1}`)
          return Number((await query(`SELECT COUNT(*) AS n FROM ${table} ${sql}`, values))[0]!.n)
        },
        all: (table) => {
          if (!TABLE.test(table)) throw new Error(`Bad table ${table}`)
          return query(`SELECT * FROM ${table}`)
        },
        async insertDoc(account, collection, id, data) {
          const json = JSON.stringify(data)
          await query('INSERT INTO docs (account, collection, id, data, bytes) VALUES ($1, $2, $3, $4::jsonb, $5)', [
            account,
            collection,
            id,
            json,
            Buffer.byteLength(json),
          ])
        },
        async insertDocs(account, collection, items) {
          const values = items.flatMap((item) => {
            const json = JSON.stringify(item)
            return [account, collection, item.id, json, Buffer.byteLength(json)]
          })
          const rows = items.map((_, index) => `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}::jsonb, $${index * 5 + 5})`)
          await query(`INSERT INTO docs (account, collection, id, data, bytes) VALUES ${rows.join(', ')}`, values)
        },
      }
    },
    async cleanup() {
      const { withPostgresPool } = await import('./postgres.ts')
      const done = opened.splice(0)
      await Promise.all(done.map(({ database }) => database.close()))
      if (done.length)
        await withPostgresPool(url, async (pool) => {
          for (const { schema } of done) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
        })
    },
  }
}

const fileSettings = envFile()
export const testDatabaseUrl =
  setting('TEST_DATABASE_URL', fileSettings) ??
  (setting('LOKHUS_MODE', fileSettings) === 'hosted' ? null : setting('DATABASE_URL', fileSettings))

export const POSTGRES_TESTS = testDatabaseUrl !== null

export const BACKENDS: TestBackend[] = [sqliteBackend(), ...(testDatabaseUrl ? [postgresBackend(testDatabaseUrl)] : [])]
