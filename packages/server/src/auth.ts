import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { LEGACY_ACCOUNT } from './db.ts'
import { DEFAULT_LIMITS, type Limits, type Mode } from './config.ts'

export const SESSION_COOKIE = 'lokhus_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_TOUCH_MS = 60 * 60 * 1000
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const SETUP_MAX_FAILURES = 5
export const SETUP_LOCK_MS = 60 * 1000
const SETUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SETUP_LENGTH = 10

export type SetupCheck = 'ok' | 'missing' | 'wrong' | 'locked'

export type ChallengePurpose = 'register' | 'add' | 'login' | 'stepup' | 'recover' | 'recover-assert' | 'wallets'

export interface Account {
  id: string
  name: string
  createdAt: string
}

export interface Passkey {
  id: string
  accountId: string
  publicKey: Uint8Array
  counter: number
  transports: string[]
  rpId: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export interface Session {
  tokenHash: string
  accountId: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
  stepUpAt: number
  label: string
}

export interface Challenge {
  challenge: string
  purpose: ChallengePurpose
  rpId: string
  accountId: string | null
  accountName: string | null
}

export const generateSetupCode = () => Array.from({ length: SETUP_LENGTH }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join('')

export const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/

export const setupCodeMatches = (code: unknown, hash: string) => {
  const given = typeof code === 'string' ? code.trim().toUpperCase() : ''
  return { given, matches: given.length > 0 && timingSafeEqual(Buffer.from(hashToken(given), 'hex'), Buffer.from(hash, 'hex')) }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

const iso = (ms: number) => new Date(ms).toISOString()

type Row = Record<string, string | number | null | Uint8Array>

const toPasskey = (row: Row): Passkey => ({
  id: row.id as string,
  accountId: row.account_id as string,
  publicKey: new Uint8Array(row.public_key as Uint8Array),
  counter: row.counter as number,
  transports: JSON.parse(row.transports as string) as string[],
  rpId: row.rp_id as string,
  name: row.name as string,
  createdAt: row.created_at as string,
  lastUsedAt: (row.last_used_at as string | null) ?? null,
})

const toSession = (row: Row): Session => ({
  tokenHash: row.token_hash as string,
  accountId: row.account_id as string,
  createdAt: row.created_at as number,
  expiresAt: row.expires_at as number,
  lastSeenAt: row.last_seen_at as number,
  stepUpAt: (row.step_up_at as number | null) ?? 0,
  label: row.label as string,
})

type NewPasskey = Omit<Passkey, 'accountId' | 'createdAt' | 'lastUsedAt'>

export interface AuthStore {
  mode: Mode
  accounts(): Promise<Account[]>
  account(id: string): Promise<Account | null>
  accountAwaitingPasskey(): Promise<Account | null>
  registrationOpen(): Promise<boolean>
  needsSetupCode(): boolean
  renameAccount(id: string, name: string): Promise<void>
  registerAccount(accountName: string, passkey: NewPasskey): Promise<Account>
  createSetupCode(): Promise<string>
  checkSetupCode(code: unknown): Promise<SetupCheck>
  addPasskey(accountId: string, passkey: NewPasskey): Promise<void>
  passkey(id: string): Promise<Passkey | null>
  passkeys(accountId: string): Promise<Passkey[]>
  usePasskey(id: string, counter: number): Promise<void>
  renamePasskey(accountId: string, id: string, name: string): Promise<boolean>
  removePasskey(accountId: string, id: string): Promise<'removed' | 'missing' | 'last'>
  createSession(accountId: string, label: string): Promise<string>
  validateSession(token: string | null): Promise<{ session: Session; refreshed: boolean } | null>
  endSession(token: string | null): Promise<void>
  endAllSessions(accountId: string): Promise<void>
  markStepUp(tokenHash: string): Promise<void>
  deleteAccount(accountId: string): Promise<void>
  saveChallenge(challenge: Challenge): Promise<void>
  consumeChallenge(challenge: string, purpose: ChallengePurpose, rpId: string): Promise<Challenge | null>
  resetLogins(): Promise<{ passkeys: number; sessions: number; setupCode: string }>
}

export interface AuthStoreOptions {
  mode?: Mode
  now?: () => number
  limits?: Pick<Limits, 'passkeysPerAccount' | 'sessionsPerAccount'>
}

export class TooManyPasskeys extends Error {}

export const createAuthStore = (db: DatabaseSync, options: AuthStoreOptions = {}): AuthStore => {
  const mode = options.mode ?? 'self'
  const now = options.now ?? Date.now
  const limits = options.limits ?? DEFAULT_LIMITS
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      label TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS setup_code (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      code_hash TEXT NOT NULL,
      failures INTEGER NOT NULL,
      locked_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      challenge TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      account_id TEXT,
      account_name TEXT,
      expires_at INTEGER NOT NULL
    );
  `)
  const sessionColumns = (db.prepare('PRAGMA table_info(sessions)').all() as Row[]).map((row) => row.name)
  if (!sessionColumns.includes('step_up_at')) db.exec('ALTER TABLE sessions ADD COLUMN step_up_at INTEGER NOT NULL DEFAULT 0')

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

  const accounts = () => db.prepare('SELECT id, name, created_at FROM accounts ORDER BY created_at').all() as Row[]

  const toAccount = (row: Row): Account => ({ id: row.id as string, name: row.name as string, createdAt: row.created_at as string })

  const passkeyCount = (accountId?: string) =>
    (
      (accountId
        ? db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?').get(accountId)
        : db.prepare('SELECT COUNT(*) AS n FROM passkeys').get()) as { n: number }
    ).n

  const store = {
    accounts: () => accounts().map(toAccount),

    account(id: string): Account | null {
      const row = db.prepare('SELECT id, name, created_at FROM accounts WHERE id = ?').get(id) as Row | undefined
      return row ? toAccount(row) : null
    },

    accountAwaitingPasskey(): Account | null {
      if (mode === 'hosted') return null
      const all = accounts()
      if (all.length !== 1 || passkeyCount() > 0) return null
      return toAccount(all[0]!)
    },

    registrationOpen(): boolean {
      return mode === 'hosted' || accounts().length === 0 || store.accountAwaitingPasskey() !== null
    },

    needsSetupCode(): boolean {
      return mode === 'self'
    },

    renameAccount(id: string, name: string) {
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id)
    },

    registerAccount(accountName: string, passkey: NewPasskey): Account {
      return transaction(() => {
        const waiting = store.accountAwaitingPasskey()
        if (mode === 'self' && !waiting && accounts().length > 0) throw new RegistrationClosed()
        const account = waiting ?? { id: randomUUID(), name: accountName, createdAt: iso(now()) }
        if (!waiting) {
          db.prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)').run(account.id, account.name, account.createdAt)
          if (mode === 'self') {
            db.prepare('UPDATE docs SET account = ? WHERE account = ?').run(account.id, LEGACY_ACCOUNT)
            db.prepare('DELETE FROM account_usage WHERE account IN (?, ?)').run(account.id, LEGACY_ACCOUNT)
          }
        }
        store.addPasskey(account.id, passkey)
        if (mode === 'self') db.prepare('DELETE FROM setup_code').run()
        return account
      })
    },

    createSetupCode(): string {
      const code = generateSetupCode()
      db.prepare(
        `INSERT INTO setup_code (singleton, code_hash, failures, locked_until) VALUES (1, ?, 0, 0)
         ON CONFLICT (singleton) DO UPDATE SET code_hash = excluded.code_hash, failures = 0, locked_until = 0`,
      ).run(hashToken(code))
      return code
    },

    checkSetupCode(code: unknown): SetupCheck {
      const row = db.prepare('SELECT code_hash, failures, locked_until FROM setup_code WHERE singleton = 1').get() as Row | undefined
      if (!row) return 'missing'
      if ((row.locked_until as number) > now()) return 'locked'
      const { given, matches } = setupCodeMatches(code, row.code_hash as string)
      if (matches) return 'ok'
      if (!given) return 'missing'
      const failures = (row.failures as number) + 1
      const locked = failures >= SETUP_MAX_FAILURES
      db.prepare('UPDATE setup_code SET failures = ?, locked_until = ? WHERE singleton = 1').run(
        locked ? 0 : failures,
        locked ? now() + SETUP_LOCK_MS : 0,
      )
      return locked ? 'locked' : 'wrong'
    },

    addPasskey(accountId: string, passkey: NewPasskey) {
      if (passkeyCount(accountId) >= limits.passkeysPerAccount) throw new TooManyPasskeys()
      db.prepare(
        `INSERT INTO passkeys (id, account_id, public_key, counter, transports, rp_id, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(passkey.id, accountId, passkey.publicKey, passkey.counter, JSON.stringify(passkey.transports), passkey.rpId, passkey.name, iso(now()))
    },

    passkey(id: string): Passkey | null {
      const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id) as Row | undefined
      return row ? toPasskey(row) : null
    },

    passkeys(accountId: string): Passkey[] {
      return (db.prepare('SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at').all(accountId) as Row[]).map(toPasskey)
    },

    usePasskey(id: string, counter: number) {
      db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, iso(now()), id)
    },

    renamePasskey(accountId: string, id: string, name: string): boolean {
      return db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND account_id = ?').run(name, id, accountId).changes > 0
    },

    removePasskey(accountId: string, id: string): 'removed' | 'missing' | 'last' {
      return transaction(() => {
        const existing = store.passkey(id)
        if (!existing || existing.accountId !== accountId) return 'missing'
        if (passkeyCount(accountId) <= 1) return 'last'
        db.prepare('DELETE FROM passkeys WHERE id = ? AND account_id = ?').run(id, accountId)
        return 'removed'
      })
    },

    createSession(accountId: string, label: string): string {
      const token = randomBytes(32).toString('base64url')
      const at = now()
      db.prepare(
        'INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at, step_up_at, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(hashToken(token), accountId, at, at + SESSION_TTL_MS, at, at, label)
      db.prepare(
        `DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (
           SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC, created_at DESC LIMIT ?
         )`,
      ).run(accountId, accountId, limits.sessionsPerAccount)
      return token
    },

    validateSession(token: string | null): { session: Session; refreshed: boolean } | null {
      if (!token || !SESSION_TOKEN.test(token)) return null
      const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as Row | undefined
      if (!row) return null
      const session = toSession(row)
      const at = now()
      if (session.expiresAt <= at) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash)
        return null
      }
      if (at - session.lastSeenAt < SESSION_TOUCH_MS) return { session, refreshed: false }
      const touched = { ...session, lastSeenAt: at, expiresAt: at + SESSION_TTL_MS }
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(at, touched.expiresAt, session.tokenHash)
      return { session: touched, refreshed: true }
    },

    endSession(token: string | null) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
    },

    endAllSessions(accountId: string) {
      db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId)
    },

    markStepUp(tokenHash: string) {
      db.prepare('UPDATE sessions SET step_up_at = ? WHERE token_hash = ?').run(now(), tokenHash)
    },

    deleteAccount(accountId: string) {
      transaction(() => {
        db.prepare('DELETE FROM docs WHERE account = ?').run(accountId)
        db.prepare('DELETE FROM account_usage WHERE account = ?').run(accountId)
        db.prepare('DELETE FROM challenges WHERE account_id = ?').run(accountId)
        db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId)
      })
    },

    saveChallenge(challenge: Challenge) {
      const at = now()
      db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(at)
      db.prepare(
        'INSERT INTO challenges (challenge, purpose, rp_id, account_id, account_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(challenge.challenge, challenge.purpose, challenge.rpId, challenge.accountId, challenge.accountName, at + CHALLENGE_TTL_MS)
    },

    consumeChallenge(challenge: string, purpose: ChallengePurpose, rpId: string): Challenge | null {
      const row = db.prepare('DELETE FROM challenges WHERE challenge = ? RETURNING *').get(challenge) as Row | undefined
      if (!row || row.purpose !== purpose || row.rp_id !== rpId || (row.expires_at as number) <= now()) return null
      return {
        challenge: row.challenge as string,
        purpose,
        rpId,
        accountId: (row.account_id as string | null) ?? null,
        accountName: (row.account_name as string | null) ?? null,
      }
    },

    resetLogins() {
      return transaction(() => {
        const passkeys = db.prepare('DELETE FROM passkeys').run().changes
        const sessions = db.prepare('DELETE FROM sessions').run().changes
        db.prepare('DELETE FROM challenges').run()
        return { passkeys: Number(passkeys), sessions: Number(sessions), setupCode: store.createSetupCode() }
      })
    },
  }
  const run =
    <A extends unknown[], R>(method: (...args: A) => R) =>
    async (...args: A) =>
      method(...args)

  return {
    mode,
    accounts: run(store.accounts),
    account: run(store.account),
    accountAwaitingPasskey: run(store.accountAwaitingPasskey),
    registrationOpen: run(store.registrationOpen),
    needsSetupCode: store.needsSetupCode,
    renameAccount: run(store.renameAccount),
    registerAccount: run(store.registerAccount),
    createSetupCode: run(store.createSetupCode),
    checkSetupCode: run(store.checkSetupCode),
    addPasskey: run(store.addPasskey),
    passkey: run(store.passkey),
    passkeys: run(store.passkeys),
    usePasskey: run(store.usePasskey),
    renamePasskey: run(store.renamePasskey),
    removePasskey: run(store.removePasskey),
    createSession: run(store.createSession),
    validateSession: run(store.validateSession),
    endSession: run(store.endSession),
    endAllSessions: run(store.endAllSessions),
    markStepUp: run(store.markStepUp),
    deleteAccount: run(store.deleteAccount),
    saveChallenge: run(store.saveChallenge),
    consumeChallenge: run(store.consumeChallenge),
    resetLogins: run(store.resetLogins),
  }
}

export class RegistrationClosed extends Error {
  constructor() {
    super('Registration is closed')
  }
}
