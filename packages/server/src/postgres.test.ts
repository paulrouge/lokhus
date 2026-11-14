import { afterAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { Database } from './database.ts'
import { testDatabaseUrl } from './testDatabases.ts'

const url = testDatabaseUrl

const schema = `lokhus_test_${randomBytes(6).toString('hex')}`
const opened: Database[] = []

const open = async () => {
  const { openPostgres } = await import('./postgres.ts')
  const database = await openPostgres(url!, { schema, max: 3 })
  opened.push(database)
  return database
}

afterAll(async () => {
  if (!url) return
  await Promise.all(opened.map((database) => database.close()))
  const { withPostgresPool } = await import('./postgres.ts')
  await withPostgresPool(url, (pool) => pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))
})

describe.skipIf(!url)('postgres', { timeout: 60_000 }, () => {
  it('runs migrations once, also when two servers start at the same time', async () => {
    const { withPostgresPool } = await import('./postgres.ts')
    await withPostgresPool(url!, (pool) => pool.query(`CREATE SCHEMA ${schema}`))
    await Promise.all([open(), open()])
    await open()
    const versions = await withPostgresPool(url!, (pool) => pool.query(`SELECT version FROM ${schema}.schema_migrations`))
    expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }])
  })

  it('shares rate limits between server processes', async () => {
    let time = 1_000
    const [first, second] = [opened[0]!.limiter(() => time), opened[1]!.limiter(() => time)]
    const rule = { limit: 2, windowMs: 60_000 }
    expect((await first.hit('ip:1', rule)).allowed).toBe(true)
    expect((await second.hit('ip:1', rule)).allowed).toBe(true)
    const blocked = await first.hit('ip:1', rule)
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 60_000 })
    time += 60_000
    expect((await second.hit('ip:1', rule)).allowed).toBe(true)
  })

  it('pages past rows whose sort fields are not numbers', async () => {
    const store = opened[0]!.docStore('junk')
    await store.put('activity', { id: 'a', safeId: 's', blockNumber: 'abc', logIndex: 0 } as never)
    await store.put('activity', { id: 'b', safeId: 's', blockNumber: '5', logIndex: 0 } as never)
    const page = await store.page('activity', {
      filter: { safeId: 's' },
      order: [{ field: 'blockNumber', numeric: true }],
      direction: 'desc',
      limit: 1,
    })
    expect(page.items.map((item) => item.id)).toEqual(['b'])
  })

  it('fails with a clear message and no password when the database cannot be reached', async () => {
    const { openPostgres } = await import('./postgres.ts')
    const attempt = openPostgres('postgres://someone:hunter2@127.0.0.1:1/nowhere')
    await expect(attempt).rejects.toThrow(/Could not use Postgres at 127\.0\.0\.1:1\/nowhere/)
    await expect(attempt).rejects.not.toThrow(/hunter2/)
  })
})
