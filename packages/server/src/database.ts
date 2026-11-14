import type { DatabaseSync } from 'node:sqlite'
import { createDocStore, openDatabase, type DocStore } from './db.ts'
import { createAuthStore, type AuthStore, type AuthStoreOptions } from './auth.ts'
import { createVaultStore, type VaultStore } from './vault.ts'
import { createMemoryRateLimiter, type RateLimiter } from './limits.ts'
import { createAcknowledgmentStore, type AcknowledgmentStore } from './acknowledgments.ts'

export interface Database {
  kind: 'sqlite' | 'postgres'
  label: string
  auth(options?: AuthStoreOptions): AuthStore
  vault(now?: () => number): VaultStore
  acknowledgments(now?: () => number): AcknowledgmentStore
  docStore(account: string): DocStore
  limiter(now?: () => number): RateLimiter
  ping(): Promise<void>
  close(): Promise<void>
}

export const sqliteDatabase = (db: DatabaseSync, label = 'SQLite'): Database => ({
  kind: 'sqlite',
  label,
  auth: (options) => createAuthStore(db, options),
  vault: (now) => createVaultStore(db, now),
  acknowledgments: (now) => createAcknowledgmentStore(db, now),
  docStore: (account) => createDocStore(db, account),
  limiter: (now) => createMemoryRateLimiter(now),
  ping: async () => {
    db.prepare('SELECT 1').get()
  },
  close: async () => db.close(),
})

export const openSqlite = (path: string): Database => sqliteDatabase(openDatabase(path), `SQLite at ${path}`)

export const openDatabaseFromEnv = async (env: NodeJS.ProcessEnv, sqlitePath: string): Promise<Database> => {
  const url = env.DATABASE_URL?.trim()
  if (!url) return openSqlite(sqlitePath)
  const { openPostgres } = await import('./postgres.ts')
  return openPostgres(url)
}
