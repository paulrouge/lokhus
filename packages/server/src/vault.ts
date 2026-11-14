import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

export const GRANT_TTL_MS = 10 * 60 * 1000
export const MAX_RECOVERY_WALLETS = 10

export type KeyKind = 'prf' | 'passphrase' | 'recovery'

export interface LockedKey {
  kind: KeyKind
  wrapped: string
  salt: string | null
}

export interface RecoveryWallets {
  addresses: string[]
  threshold: number
}

export interface KeyStatus {
  check: string | null
  migrated: boolean
  keys: { passkeyId: string; kind: KeyKind }[]
  hasRecoveryCode: boolean
  wallets: RecoveryWallets | null
}

export interface VaultExport {
  check: string | null
  keys: ({ passkeyId: string } & LockedKey)[]
  recovery: LockedKey | null
}

export interface VaultStore {
  status(accountId: string): Promise<KeyStatus>
  setCheck(accountId: string, check: string): Promise<string>
  markMigrated(accountId: string): Promise<void>
  lockedKey(accountId: string, passkeyId: string): Promise<LockedKey | null>
  putLockedKey(accountId: string, passkeyId: string, key: LockedKey): Promise<'saved' | 'missing'>
  setRecoveryCode(accountId: string, authHash: string, key: LockedKey): Promise<void>
  recoveryByCode(authHash: string): Promise<{ accountId: string; key: LockedKey } | null>
  setRecoveryWallets(accountId: string, wallets: RecoveryWallets | null): Promise<void>
  walletAccounts(addresses: string[]): Promise<{ accountId: string; threshold: number; matched: number }[]>
  createGrant(accountId: string): Promise<string>
  grant(token: string): Promise<string | null>
  consumeGrant(token: string): Promise<string | null>
  exportKeys(accountId: string): Promise<VaultExport>
  resetEncryption(accountId: string): Promise<void>
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

type Row = Record<string, string | number | null>

export const createVaultStore = (db: DatabaseSync, now: () => number = Date.now): VaultStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_keys (
      account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
      key_check TEXT,
      migrated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS locked_keys (
      passkey_id TEXT PRIMARY KEY REFERENCES passkeys (id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      wrapped TEXT NOT NULL,
      salt TEXT
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
      auth_hash TEXT NOT NULL UNIQUE,
      wrapped TEXT NOT NULL,
      salt TEXT
    );
    CREATE TABLE IF NOT EXISTS recovery_wallets (
      account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
      threshold INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery_wallet_addresses (
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      PRIMARY KEY (account_id, address)
    );
    CREATE INDEX IF NOT EXISTS recovery_wallet_by_address ON recovery_wallet_addresses (address);
    CREATE TABLE IF NOT EXISTS recovery_grants (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `)

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

  const ensureRow = (accountId: string) => db.prepare('INSERT OR IGNORE INTO account_keys (account_id) VALUES (?)').run(accountId)

  const toLocked = (row: Row): LockedKey => ({ kind: row.kind as KeyKind, wrapped: row.wrapped as string, salt: (row.salt as string | null) ?? null })

  const wallets = (accountId: string): RecoveryWallets | null => {
    const row = db.prepare('SELECT threshold FROM recovery_wallets WHERE account_id = ?').get(accountId) as Row | undefined
    if (!row) return null
    const addresses = (db.prepare('SELECT address FROM recovery_wallet_addresses WHERE account_id = ? ORDER BY address').all(accountId) as Row[]).map(
      (entry) => entry.address as string,
    )
    return { addresses, threshold: row.threshold as number }
  }

  const store = {
    status(accountId: string): KeyStatus {
      const row = db.prepare('SELECT key_check, migrated FROM account_keys WHERE account_id = ?').get(accountId) as Row | undefined
      const keys = (db.prepare('SELECT passkey_id, kind FROM locked_keys WHERE account_id = ?').all(accountId) as Row[]).map((entry) => ({
        passkeyId: entry.passkey_id as string,
        kind: entry.kind as KeyKind,
      }))
      const code = db.prepare('SELECT 1 FROM recovery_codes WHERE account_id = ?').get(accountId)
      return {
        check: (row?.key_check as string | null) ?? null,
        migrated: row?.migrated === 1,
        keys,
        hasRecoveryCode: !!code,
        wallets: wallets(accountId),
      }
    },

    setCheck(accountId: string, check: string): string {
      return transaction(() => {
        ensureRow(accountId)
        db.prepare('UPDATE account_keys SET key_check = ? WHERE account_id = ? AND key_check IS NULL').run(check, accountId)
        return (db.prepare('SELECT key_check FROM account_keys WHERE account_id = ?').get(accountId) as Row).key_check as string
      })
    },

    markMigrated(accountId: string) {
      ensureRow(accountId)
      db.prepare('UPDATE account_keys SET migrated = 1 WHERE account_id = ?').run(accountId)
    },

    lockedKey(accountId: string, passkeyId: string): LockedKey | null {
      const row = db.prepare('SELECT kind, wrapped, salt FROM locked_keys WHERE passkey_id = ? AND account_id = ?').get(passkeyId, accountId) as
        | Row
        | undefined
      return row ? toLocked(row) : null
    },

    putLockedKey(accountId: string, passkeyId: string, key: LockedKey): 'saved' | 'missing' {
      const owned = db.prepare('SELECT 1 FROM passkeys WHERE id = ? AND account_id = ?').get(passkeyId, accountId)
      if (!owned) return 'missing'
      db.prepare(
        `INSERT INTO locked_keys (passkey_id, account_id, kind, wrapped, salt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (passkey_id) DO UPDATE SET kind = excluded.kind, wrapped = excluded.wrapped, salt = excluded.salt`,
      ).run(passkeyId, accountId, key.kind, key.wrapped, key.salt)
      return 'saved'
    },

    setRecoveryCode(accountId: string, authHash: string, key: LockedKey) {
      db.prepare(
        `INSERT INTO recovery_codes (account_id, auth_hash, wrapped, salt) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET auth_hash = excluded.auth_hash, wrapped = excluded.wrapped, salt = excluded.salt`,
      ).run(accountId, authHash, key.wrapped, key.salt)
    },

    recoveryByCode(authHash: string) {
      const row = db.prepare('SELECT account_id, wrapped, salt FROM recovery_codes WHERE auth_hash = ?').get(authHash) as Row | undefined
      return row ? { accountId: row.account_id as string, key: toLocked({ ...row, kind: 'recovery' }) } : null
    },

    setRecoveryWallets(accountId: string, next: RecoveryWallets | null) {
      transaction(() => {
        db.prepare('DELETE FROM recovery_wallet_addresses WHERE account_id = ?').run(accountId)
        db.prepare('DELETE FROM recovery_wallets WHERE account_id = ?').run(accountId)
        if (!next) return
        db.prepare('INSERT INTO recovery_wallets (account_id, threshold) VALUES (?, ?)').run(accountId, next.threshold)
        for (const address of next.addresses)
          db.prepare('INSERT INTO recovery_wallet_addresses (account_id, address) VALUES (?, ?)').run(accountId, address)
      })
    },

    walletAccounts(addresses: string[]) {
      if (addresses.length === 0) return []
      const rows = db
        .prepare(
          `SELECT a.account_id, w.threshold, COUNT(DISTINCT a.address) AS matched
           FROM recovery_wallet_addresses a JOIN recovery_wallets w ON w.account_id = a.account_id
           WHERE a.address IN (${addresses.map(() => '?').join(', ')})
           GROUP BY a.account_id, w.threshold`,
        )
        .all(...addresses) as Row[]
      return rows.map((row) => ({ accountId: row.account_id as string, threshold: row.threshold as number, matched: row.matched as number }))
    },

    createGrant(accountId: string): string {
      const token = randomBytes(32).toString('base64url')
      db.prepare('DELETE FROM recovery_grants WHERE expires_at <= ?').run(now())
      db.prepare('INSERT INTO recovery_grants (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), accountId, now() + GRANT_TTL_MS)
      return token
    },

    grant(token: string): string | null {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
      const row = db.prepare('SELECT account_id, expires_at FROM recovery_grants WHERE token_hash = ?').get(sha256(token)) as Row | undefined
      return row && (row.expires_at as number) > now() ? (row.account_id as string) : null
    },

    consumeGrant(token: string): string | null {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
      const row = db.prepare('DELETE FROM recovery_grants WHERE token_hash = ? RETURNING account_id, expires_at').get(sha256(token)) as Row | undefined
      return row && (row.expires_at as number) > now() ? (row.account_id as string) : null
    },

    resetEncryption(accountId: string) {
      transaction(() => {
        db.prepare('DELETE FROM docs WHERE account = ?').run(accountId)
        db.prepare('DELETE FROM account_usage WHERE account = ?').run(accountId)
        db.prepare('DELETE FROM locked_keys WHERE account_id = ?').run(accountId)
        db.prepare('DELETE FROM recovery_codes WHERE account_id = ?').run(accountId)
        db.prepare('DELETE FROM account_keys WHERE account_id = ?').run(accountId)
      })
    },

    exportKeys(accountId: string): VaultExport {
      const keys = (db.prepare('SELECT passkey_id, kind, wrapped, salt FROM locked_keys WHERE account_id = ?').all(accountId) as Row[]).map((row) => ({
        passkeyId: row.passkey_id as string,
        ...toLocked(row),
      }))
      const recovery = db.prepare('SELECT wrapped, salt FROM recovery_codes WHERE account_id = ?').get(accountId) as Row | undefined
      return {
        check: store.status(accountId).check,
        keys,
        recovery: recovery ? toLocked({ ...recovery, kind: 'recovery' }) : null,
      }
    },
  }

  const run =
    <A extends unknown[], R>(method: (...args: A) => R) =>
    async (...args: A) =>
      method(...args)

  return {
    status: run(store.status),
    setCheck: run(store.setCheck),
    markMigrated: run(store.markMigrated),
    lockedKey: run(store.lockedKey),
    putLockedKey: run(store.putLockedKey),
    setRecoveryCode: run(store.setRecoveryCode),
    recoveryByCode: run(store.recoveryByCode),
    setRecoveryWallets: run(store.setRecoveryWallets),
    walletAccounts: run(store.walletAccounts),
    createGrant: run(store.createGrant),
    grant: run(store.grant),
    consumeGrant: run(store.consumeGrant),
    exportKeys: run(store.exportKeys),
    resetEncryption: run(store.resetEncryption),
  }
}

export const hashRecoveryAuth = (authSecret: string) => sha256(`lokhus recovery ${authSecret}`)
