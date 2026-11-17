import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openPostgres, withPostgresPool } from '../packages/server/src/postgres.ts'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const fromFlag = args.indexOf('--from')
const source = fromFlag >= 0 ? args[fromFlag + 1] : (process.env.MSA_DB ?? join(ROOT, 'data/app.db'))
const target = process.env.DATABASE_URL?.trim()

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

if (!source || !existsSync(source)) fail(`No SQLite database at ${source}`)
if (!target) fail('Set DATABASE_URL to the Postgres database to copy into.')

type Row = Record<string, unknown>

const TABLES: { name: string; convert?: (row: Row) => Row }[] = [
  { name: 'accounts' },
  { name: 'passkeys', convert: (row) => ({ ...row, public_key: Buffer.from(row.public_key as Uint8Array) }) },
  { name: 'sessions' },
  { name: 'setup_code' },
  { name: 'account_keys', convert: (row) => ({ ...row, migrated: row.migrated === 1 }) },
  { name: 'locked_keys' },
  { name: 'recovery_codes' },
  { name: 'recovery_wallets' },
  { name: 'recovery_wallet_addresses' },
  { name: 'acknowledgments' },
  { name: 'eligibility_confirmations' },
  {
    name: 'docs',
    convert: (row) => ({ account: row.account, collection: row.collection, id: row.id, data: row.data, bytes: Buffer.byteLength(row.data as string) }),
  },
]

const sqlite = new DatabaseSync(source!, { readOnly: true })
const existing = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => row.name as string))
const plan = TABLES.filter((table) => existing.has(table.name)).map((table) => ({
  ...table,
  rows: (sqlite.prepare(`SELECT * FROM ${table.name}`).all() as Row[]).map((row) => (table.convert ? table.convert(row) : { ...row })),
}))

console.log(`Copying from ${source}`)
for (const table of plan) console.log(`  ${table.name}: ${table.rows.length}`)

const database = await openPostgres(target!).catch((error: Error) => fail(error.message))
console.log(`Into ${database.label}`)
await database.close()

await withPostgresPool(target!, async (pool) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const busy = await client.query('SELECT (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM docs) AS n')
    if (Number(busy.rows[0].n) > 0) fail('The Postgres database already has accounts or documents. Copy only into an empty database.')
    for (const table of plan) {
      for (const row of table.rows) {
        const columns = Object.keys(row)
        const values = columns.map((column) => row[column])
        const placeholders = columns.map((column, index) => (table.name === 'docs' && column === 'data' ? `$${index + 1}::jsonb` : `$${index + 1}`))
        await client.query(`INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, values)
      }
    }
    await client.query('INSERT INTO account_usage (account, bytes) SELECT account, SUM(bytes) FROM docs GROUP BY account')
    if (dryRun) {
      await client.query('ROLLBACK')
      console.log('Dry run: everything fits, nothing was written.')
    } else {
      await client.query('COMMIT')
      console.log('Done. Point DATABASE_URL at this database and restart Lokhus.')
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
})
sqlite.close()
