import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { openDatabaseFromEnv } from '../packages/server/src/database.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DB_PATH = process.env.MSA_DB ?? join(ROOT, 'data/app.db')
const PORT = Number(process.env.PORT_API ?? 8787)

if ((process.env.LOKHUS_MODE ?? 'self') !== 'self') {
  console.error('reset-login only works in self-hosted mode. In hosted mode it would sign out and remove the passkeys of every user.')
  process.exit(1)
}

if (!process.env.DATABASE_URL?.trim() && !existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}`)
  process.exit(1)
}

let database
try {
  database = await openDatabaseFromEnv(process.env, DB_PATH)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const auth = database.auth()
const accounts = await auth.accounts()
const removed = await auth.resetLogins()
await database.close()
console.log(`Removed ${removed.passkeys} passkey(s) and ${removed.sessions} session(s). Your Safes, signers and notes are untouched.`)
if (accounts.length > 1) console.log('There is more than one account, so a new passkey cannot be attached automatically.')
else console.log(`Open http://localhost:${PORT}/signin?setup=${removed.setupCode} to create your passkey. The link works once.`)
