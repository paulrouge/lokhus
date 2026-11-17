import pg from 'pg'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Filter } from '@msa/core/storage'
import {
  InvalidPageQuery,
  LEGACY_ACCOUNT,
  accountFull,
  assertField,
  decodeCursor,
  encodeCursor,
  pageLimit,
  tooManyDocs,
  type DocStore,
} from './db.ts'
import {
  CHALLENGE_TTL_MS,
  RegistrationClosed,
  SESSION_TOKEN,
  SESSION_TOUCH_MS,
  SESSION_TTL_MS,
  SETUP_LOCK_MS,
  SETUP_MAX_FAILURES,
  TooManyPasskeys,
  generateSetupCode,
  hashToken,
  setupCodeMatches,
  type Account,
  type AuthStore,
  type AuthStoreOptions,
  type Challenge,
  type ChallengePurpose,
  type Passkey,
  type Session,
} from './auth.ts'
import { GRANT_TTL_MS, sha256, type KeyKind, type LockedKey, type RecoveryWallets, type VaultStore } from './vault.ts'
import { DEFAULT_LIMITS } from './config.ts'
import type { RateLimiter } from './limits.ts'
import type { Database } from './database.ts'
import { toAcknowledgment, toEligibility, type AcknowledgmentStore } from './acknowledgments.ts'

type Query = pg.Pool | pg.PoolClient
type Row = Record<string, unknown>

const MIGRATIONS = [
  `
  CREATE FUNCTION lokhus_num(value text) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
    $$ SELECT CASE WHEN value ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN value::numeric END $$;

  CREATE TABLE docs (
    account text NOT NULL,
    collection text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL,
    bytes integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account, collection, id)
  );
  CREATE INDEX docs_by_created ON docs (account, collection, created_at, id);
  CREATE INDEX docs_activity_by_safe ON docs (
    account, collection, (data->>'safeId'), lokhus_num(data->>'blockNumber'), lokhus_num(data->>'logIndex'), id
  );
  CREATE TABLE account_usage (account text PRIMARY KEY, bytes bigint NOT NULL);

  CREATE TABLE accounts (id text PRIMARY KEY, name text NOT NULL, created_at text NOT NULL);
  CREATE TABLE passkeys (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    public_key bytea NOT NULL,
    counter bigint NOT NULL,
    transports text NOT NULL,
    rp_id text NOT NULL,
    name text NOT NULL,
    created_at text NOT NULL,
    last_used_at text
  );
  CREATE INDEX passkeys_by_account ON passkeys (account_id, created_at);
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    step_up_at bigint NOT NULL DEFAULT 0,
    label text NOT NULL
  );
  CREATE INDEX sessions_by_account ON sessions (account_id, last_seen_at DESC);
  CREATE TABLE setup_code (
    singleton integer PRIMARY KEY CHECK (singleton = 1),
    code_hash text NOT NULL,
    failures integer NOT NULL,
    locked_until bigint NOT NULL
  );
  CREATE TABLE challenges (
    challenge text PRIMARY KEY,
    purpose text NOT NULL,
    rp_id text NOT NULL,
    account_id text,
    account_name text,
    expires_at bigint NOT NULL
  );
  CREATE INDEX challenges_by_expiry ON challenges (expires_at);

  CREATE TABLE account_keys (
    account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    key_check text,
    migrated boolean NOT NULL DEFAULT false
  );
  CREATE TABLE locked_keys (
    passkey_id text PRIMARY KEY REFERENCES passkeys (id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind text NOT NULL,
    wrapped text NOT NULL,
    salt text
  );
  CREATE TABLE recovery_codes (
    account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    auth_hash text NOT NULL UNIQUE,
    wrapped text NOT NULL,
    salt text
  );
  CREATE TABLE recovery_wallets (
    account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    threshold integer NOT NULL
  );
  CREATE TABLE recovery_wallet_addresses (
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    address text NOT NULL,
    PRIMARY KEY (account_id, address)
  );
  CREATE INDEX recovery_wallet_by_address ON recovery_wallet_addresses (address);
  CREATE TABLE recovery_grants (
    token_hash text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at bigint NOT NULL
  );

  CREATE TABLE rate_limits (key text PRIMARY KEY, window_start bigint NOT NULL, count integer NOT NULL);
  CREATE INDEX rate_limits_by_window ON rate_limits (window_start);
  `,
  `
  CREATE TABLE acknowledgments (
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind text NOT NULL,
    version integer NOT NULL,
    message text NOT NULL,
    signature text NOT NULL,
    signer text NOT NULL,
    safe text NOT NULL,
    chain_id bigint NOT NULL,
    block_number text NOT NULL,
    signed_date text NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY (account_id, kind, version)
  );
  `,
  `
  CREATE TABLE eligibility_confirmations (
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    version integer NOT NULL,
    statement text NOT NULL,
    confirmed_at text NOT NULL,
    PRIMARY KEY (account_id, version)
  );
  `,
]

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

const types = {
  getTypeParser: ((oid: number, format?: string) =>
    oid === pg.types.builtins.INT8 ? (value: string) => Number(value) : pg.types.getTypeParser(oid, format as 'text')) as never,
}

const describeUrl = (url: string) => {
  try {
    const parsed = new URL(url)
    return `Postgres at ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`
  } catch {
    return 'Postgres'
  }
}

const withoutSecrets = (message: string) => message.replace(/\/\/[^@\s/]*@/g, '//***@')

const iso = (ms: number) => new Date(ms).toISOString()

const transaction = async <T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

const rows = async (q: Query, text: string, values: unknown[] = []) => (await q.query(text, values)).rows as Row[]
const one = async (q: Query, text: string, values: unknown[] = []) => (await rows(q, text, values))[0] ?? null
const changed = async (q: Query, text: string, values: unknown[] = []) => (await q.query(text, values)).rowCount ?? 0

export const migrate = async (pool: pg.Pool) =>
  transaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':lokhus-migrations'))`)
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const applied = new Set((await rows(client, 'SELECT version FROM schema_migrations')).map((row) => row.version as number))
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1
      if (applied.has(version)) continue
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
    }
  })

const keyExpression = (field: string, numeric?: boolean) => {
  assertField(field)
  return numeric ? `lokhus_num(data->>'${field}')` : `(data->>'${field}')`
}

const filterClause = (filter: Filter, firstParam: number) => {
  const entries = Object.entries(filter)
  entries.forEach(([field]) => assertField(field))
  return {
    where: entries.map(([field], index) => `AND (data->>'${field}') = $${firstParam + index}`).join(' '),
    values: entries.map(([, value]) => String(value)),
  }
}

const createPgDocStore = (pool: pg.Pool, account: string): DocStore => {
  const lockUsage = async (client: pg.PoolClient) => {
    await client.query(
      `INSERT INTO account_usage (account, bytes) SELECT $1, COALESCE(SUM(bytes), 0) FROM docs WHERE account = $1
       ON CONFLICT (account) DO NOTHING`,
      [account],
    )
    return (await one(client, 'SELECT bytes FROM account_usage WHERE account = $1 FOR UPDATE', [account]))!.bytes as number
  }

  const sizeOf = async (q: Query, collection: string, id: string) =>
    ((await one(q, 'SELECT bytes FROM docs WHERE account = $1 AND collection = $2 AND id = $3', [account, collection, id]))?.bytes as
      | number
      | undefined) ?? null

  return {
    async list(collection, filter) {
      const { where, values } = filterClause(filter, 3)
      const found = await rows(pool, `SELECT data FROM docs WHERE account = $1 AND collection = $2 ${where} ORDER BY created_at, id`, [
        account,
        collection,
        ...values,
      ])
      return found.map((row) => row.data as never)
    },
    async page(collection, query) {
      if (query.order.length === 0) throw new InvalidPageQuery('Order by at least one field')
      const limit = pageLimit(query.limit)
      const keys = [...query.order.map(({ field, numeric }) => keyExpression(field, numeric)), 'id']
      const { where, values } = filterClause(query.filter ?? {}, 3)
      const ascending = query.direction === 'asc'
      const after = query.cursor ? decodeCursor(query.cursor, keys.length) : null
      const params: unknown[] = [account, collection, ...values]
      const cursorClause = after
        ? `AND (${keys.join(', ')}) ${ascending ? '>' : '<'} (${after.map((value) => `$${params.push(value === null ? null : String(value))}`).join(', ')})`
        : ''
      const order = keys.map((key) => `${key} ${ascending ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'}`).join(', ')
      const found = await rows(
        pool,
        `SELECT data, ${keys.map((key, index) => `${key} AS k${index}`).join(', ')} FROM docs
         WHERE account = $1 AND collection = $2 ${where} ${cursorClause}
         ORDER BY ${order} LIMIT $${params.push(limit + 1)}`,
        params,
      )
      const pageRows = found.slice(0, limit)
      const last = pageRows[pageRows.length - 1]
      return {
        items: pageRows.map((row) => row.data as never),
        nextCursor: found.length > limit && last ? encodeCursor(keys.map((_, index) => (last[`k${index}`] as string | null) ?? null)) : null,
      }
    },
    async get(collection, id) {
      return ((await one(pool, 'SELECT data FROM docs WHERE account = $1 AND collection = $2 AND id = $3', [account, collection, id]))?.data ??
        null) as never
    },
    async put(collection, item, quota) {
      const data = JSON.stringify(item)
      const bytes = Buffer.byteLength(data)
      return transaction(pool, async (client) => {
        const used = await lockUsage(client)
        const previous = await sizeOf(client, collection, item.id)
        const next = used - (previous ?? 0) + bytes
        if (quota) {
          if (previous === null) {
            const count = (await one(client, 'SELECT COUNT(*) AS n FROM docs WHERE account = $1 AND collection = $2', [account, collection]))!
              .n as number
            if (count >= quota.maxDocs) throw tooManyDocs(quota, collection)
          }
          if (next > quota.maxAccountBytes && next > used) throw accountFull(quota)
        }
        await client.query(
          `INSERT INTO docs (account, collection, id, data, bytes) VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (account, collection, id) DO UPDATE SET data = excluded.data, bytes = excluded.bytes, updated_at = clock_timestamp()`,
          [account, collection, item.id, data, bytes],
        )
        await client.query('UPDATE account_usage SET bytes = $2 WHERE account = $1', [account, next])
        return item
      })
    },
    async remove(collection, id) {
      await transaction(pool, async (client) => {
        const used = await lockUsage(client)
        const previous = await sizeOf(client, collection, id)
        if (previous === null) return
        await client.query('DELETE FROM docs WHERE account = $1 AND collection = $2 AND id = $3', [account, collection, id])
        await client.query('UPDATE account_usage SET bytes = $2 WHERE account = $1', [account, Math.max(0, used - previous)])
      })
    },
    async count(collection) {
      return (await one(pool, 'SELECT COUNT(*) AS n FROM docs WHERE account = $1 AND collection = $2', [account, collection]))!.n as number
    },
    async usage() {
      return transaction(pool, async (client) => ({ bytes: await lockUsage(client) }))
    },
    async removePlaintext(collection) {
      return transaction(pool, async (client) => {
        await lockUsage(client)
        const removed = await changed(client, `DELETE FROM docs WHERE account = $1 AND collection = $2 AND NOT (data ? 'enc')`, [account, collection])
        await client.query('UPDATE account_usage SET bytes = (SELECT COALESCE(SUM(bytes), 0) FROM docs WHERE account = $1) WHERE account = $1', [
          account,
        ])
        return removed
      })
    },
    async exportAll() {
      const found = await rows(pool, 'SELECT collection, id, data FROM docs WHERE account = $1 ORDER BY collection COLLATE "C", id COLLATE "C"', [account])
      return found.map((row) => ({ collection: row.collection as string, id: row.id as string, data: row.data }))
    },
  }
}

const toAccount = (row: Row): Account => ({ id: row.id as string, name: row.name as string, createdAt: row.created_at as string })

const toPasskey = (row: Row): Passkey => ({
  id: row.id as string,
  accountId: row.account_id as string,
  publicKey: new Uint8Array(row.public_key as Buffer),
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

const createPgAuthStore = (pool: pg.Pool, options: AuthStoreOptions = {}): AuthStore => {
  const mode = options.mode ?? 'self'
  const now = options.now ?? Date.now
  const limits = options.limits ?? DEFAULT_LIMITS

  const allAccounts = async (q: Query) => (await rows(q, 'SELECT id, name, created_at FROM accounts ORDER BY created_at, id')).map(toAccount)

  const passkeyCount = async (q: Query, accountId?: string) =>
    (accountId
      ? await one(q, 'SELECT COUNT(*) AS n FROM passkeys WHERE account_id = $1', [accountId])
      : await one(q, 'SELECT COUNT(*) AS n FROM passkeys'))!.n as number

  const awaiting = async (q: Query): Promise<Account | null> => {
    if (mode === 'hosted') return null
    const all = await allAccounts(q)
    if (all.length !== 1 || (await passkeyCount(q)) > 0) return null
    return all[0]!
  }

  const insertPasskey = async (client: pg.PoolClient, accountId: string, passkey: NewPasskey) => {
    await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId])
    if ((await passkeyCount(client, accountId)) >= limits.passkeysPerAccount) throw new TooManyPasskeys()
    await client.query(
      `INSERT INTO passkeys (id, account_id, public_key, counter, transports, rp_id, name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [passkey.id, accountId, Buffer.from(passkey.publicKey), passkey.counter, JSON.stringify(passkey.transports), passkey.rpId, passkey.name, iso(now())],
    )
  }

  const saveSetupCode = async (q: Query) => {
    const code = generateSetupCode()
    await q.query(
      `INSERT INTO setup_code (singleton, code_hash, failures, locked_until) VALUES (1, $1, 0, 0)
       ON CONFLICT (singleton) DO UPDATE SET code_hash = excluded.code_hash, failures = 0, locked_until = 0`,
      [hashToken(code)],
    )
    return code
  }

  return {
    mode,
    accounts: () => allAccounts(pool),
    account: async (id) => {
      const row = await one(pool, 'SELECT id, name, created_at FROM accounts WHERE id = $1', [id])
      return row ? toAccount(row) : null
    },
    accountAwaitingPasskey: () => awaiting(pool),
    registrationOpen: async () => mode === 'hosted' || (await allAccounts(pool)).length === 0 || (await awaiting(pool)) !== null,
    needsSetupCode: () => mode === 'self',
    renameAccount: async (id, name) => {
      await pool.query('UPDATE accounts SET name = $2 WHERE id = $1', [id, name])
    },
    registerAccount: (accountName, passkey) =>
      transaction(pool, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':lokhus-register'))`)
        const waiting = await awaiting(client)
        if (mode === 'self' && !waiting && (await allAccounts(client)).length > 0) throw new RegistrationClosed()
        const account = waiting ?? { id: randomUUID(), name: accountName, createdAt: iso(now()) }
        if (!waiting) {
          await client.query('INSERT INTO accounts (id, name, created_at) VALUES ($1, $2, $3)', [account.id, account.name, account.createdAt])
          if (mode === 'self') {
            await client.query('UPDATE docs SET account = $1 WHERE account = $2', [account.id, LEGACY_ACCOUNT])
            await client.query('DELETE FROM account_usage WHERE account IN ($1, $2)', [account.id, LEGACY_ACCOUNT])
          }
        }
        await insertPasskey(client, account.id, passkey)
        if (mode === 'self') await client.query('DELETE FROM setup_code')
        return account
      }),
    createSetupCode: () => saveSetupCode(pool),
    checkSetupCode: (code) =>
      transaction(pool, async (client) => {
        const row = await one(client, 'SELECT code_hash, failures, locked_until FROM setup_code WHERE singleton = 1 FOR UPDATE')
        if (!row) return 'missing'
        if ((row.locked_until as number) > now()) return 'locked'
        const { given, matches } = setupCodeMatches(code, row.code_hash as string)
        if (matches) return 'ok'
        if (!given) return 'missing'
        const failures = (row.failures as number) + 1
        const locked = failures >= SETUP_MAX_FAILURES
        await client.query('UPDATE setup_code SET failures = $1, locked_until = $2 WHERE singleton = 1', [
          locked ? 0 : failures,
          locked ? now() + SETUP_LOCK_MS : 0,
        ])
        return locked ? 'locked' : 'wrong'
      }),
    addPasskey: (accountId, passkey) => transaction(pool, (client) => insertPasskey(client, accountId, passkey)),
    passkey: async (id) => {
      const row = await one(pool, 'SELECT * FROM passkeys WHERE id = $1', [id])
      return row ? toPasskey(row) : null
    },
    passkeys: async (accountId) => (await rows(pool, 'SELECT * FROM passkeys WHERE account_id = $1 ORDER BY created_at, id', [accountId])).map(toPasskey),
    usePasskey: async (id, counter) => {
      await pool.query('UPDATE passkeys SET counter = $2, last_used_at = $3 WHERE id = $1', [id, counter, iso(now())])
    },
    renamePasskey: async (accountId, id, name) =>
      (await changed(pool, 'UPDATE passkeys SET name = $3 WHERE id = $1 AND account_id = $2', [id, accountId, name])) > 0,
    removePasskey: (accountId, id) =>
      transaction(pool, async (client) => {
        await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId])
        const existing = await one(client, 'SELECT account_id FROM passkeys WHERE id = $1', [id])
        if (!existing || existing.account_id !== accountId) return 'missing' as const
        if ((await passkeyCount(client, accountId)) <= 1) return 'last' as const
        await client.query('DELETE FROM passkeys WHERE id = $1 AND account_id = $2', [id, accountId])
        return 'removed' as const
      }),
    createSession: (accountId, label) =>
      transaction(pool, async (client) => {
        const token = randomBytes(32).toString('base64url')
        const at = now()
        await client.query(
          'INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at, step_up_at, label) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [hashToken(token), accountId, at, at + SESSION_TTL_MS, at, at, label],
        )
        await client.query(
          `DELETE FROM sessions WHERE account_id = $1 AND token_hash NOT IN (
             SELECT token_hash FROM sessions WHERE account_id = $1 ORDER BY last_seen_at DESC, created_at DESC LIMIT $2
           )`,
          [accountId, limits.sessionsPerAccount],
        )
        return token
      }),
    validateSession: async (token) => {
      if (!token || !SESSION_TOKEN.test(token)) return null
      const row = await one(pool, 'SELECT * FROM sessions WHERE token_hash = $1', [hashToken(token)])
      if (!row) return null
      const session = toSession(row)
      const at = now()
      if (session.expiresAt <= at) {
        await pool.query('DELETE FROM sessions WHERE token_hash = $1', [session.tokenHash])
        return null
      }
      if (at - session.lastSeenAt < SESSION_TOUCH_MS) return { session, refreshed: false }
      const touched = { ...session, lastSeenAt: at, expiresAt: at + SESSION_TTL_MS }
      await pool.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE token_hash = $1', [session.tokenHash, at, touched.expiresAt])
      return { session: touched, refreshed: true }
    },
    endSession: async (token) => {
      if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
    },
    endAllSessions: async (accountId) => {
      await pool.query('DELETE FROM sessions WHERE account_id = $1', [accountId])
    },
    markStepUp: async (tokenHash) => {
      await pool.query('UPDATE sessions SET step_up_at = $2 WHERE token_hash = $1', [tokenHash, now()])
    },
    deleteAccount: (accountId) =>
      transaction(pool, async (client) => {
        await client.query('DELETE FROM docs WHERE account = $1', [accountId])
        await client.query('DELETE FROM account_usage WHERE account = $1', [accountId])
        await client.query('DELETE FROM challenges WHERE account_id = $1', [accountId])
        await client.query('DELETE FROM accounts WHERE id = $1', [accountId])
      }),
    saveChallenge: async (challenge: Challenge) => {
      const at = now()
      await pool.query('DELETE FROM challenges WHERE expires_at <= $1', [at])
      await pool.query(
        'INSERT INTO challenges (challenge, purpose, rp_id, account_id, account_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [challenge.challenge, challenge.purpose, challenge.rpId, challenge.accountId, challenge.accountName, at + CHALLENGE_TTL_MS],
      )
    },
    consumeChallenge: async (challenge: string, purpose: ChallengePurpose, rpId: string) => {
      const row = await one(pool, 'DELETE FROM challenges WHERE challenge = $1 RETURNING *', [challenge])
      if (!row || row.purpose !== purpose || row.rp_id !== rpId || (row.expires_at as number) <= now()) return null
      return {
        challenge: row.challenge as string,
        purpose,
        rpId,
        accountId: (row.account_id as string | null) ?? null,
        accountName: (row.account_name as string | null) ?? null,
      }
    },
    resetLogins: () =>
      transaction(pool, async (client) => {
        const passkeys = await changed(client, 'DELETE FROM passkeys')
        const sessions = await changed(client, 'DELETE FROM sessions')
        await client.query('DELETE FROM challenges')
        return { passkeys, sessions, setupCode: await saveSetupCode(client) }
      }),
  }
}

const toLocked = (row: Row, kind?: KeyKind): LockedKey => ({
  kind: kind ?? (row.kind as KeyKind),
  wrapped: row.wrapped as string,
  salt: (row.salt as string | null) ?? null,
})

const createPgVaultStore = (pool: pg.Pool, now: () => number = Date.now): VaultStore => {
  const ensureRow = (q: Query, accountId: string) => q.query('INSERT INTO account_keys (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING', [accountId])

  const wallets = async (accountId: string): Promise<RecoveryWallets | null> => {
    const row = await one(pool, 'SELECT threshold FROM recovery_wallets WHERE account_id = $1', [accountId])
    if (!row) return null
    const addresses = (await rows(pool, 'SELECT address FROM recovery_wallet_addresses WHERE account_id = $1 ORDER BY address COLLATE "C"', [accountId])).map(
      (entry) => entry.address as string,
    )
    return { addresses, threshold: row.threshold as number }
  }

  const check = async (accountId: string) =>
    ((await one(pool, 'SELECT key_check FROM account_keys WHERE account_id = $1', [accountId]))?.key_check as string | null | undefined) ?? null

  const validGrant = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token)

  return {
    status: async (accountId) => {
      const row = await one(pool, 'SELECT key_check, migrated FROM account_keys WHERE account_id = $1', [accountId])
      const keys = (await rows(pool, 'SELECT passkey_id, kind FROM locked_keys WHERE account_id = $1', [accountId])).map((entry) => ({
        passkeyId: entry.passkey_id as string,
        kind: entry.kind as KeyKind,
      }))
      const code = await one(pool, 'SELECT 1 AS present FROM recovery_codes WHERE account_id = $1', [accountId])
      return {
        check: (row?.key_check as string | null | undefined) ?? null,
        migrated: row?.migrated === true,
        keys,
        hasRecoveryCode: !!code,
        wallets: await wallets(accountId),
      }
    },
    setCheck: (accountId, value) =>
      transaction(pool, async (client) => {
        await ensureRow(client, accountId)
        await client.query('UPDATE account_keys SET key_check = $2 WHERE account_id = $1 AND key_check IS NULL', [accountId, value])
        return (await one(client, 'SELECT key_check FROM account_keys WHERE account_id = $1', [accountId]))!.key_check as string
      }),
    markMigrated: async (accountId) => {
      await ensureRow(pool, accountId)
      await pool.query('UPDATE account_keys SET migrated = true WHERE account_id = $1', [accountId])
    },
    lockedKey: async (accountId, passkeyId) => {
      const row = await one(pool, 'SELECT kind, wrapped, salt FROM locked_keys WHERE passkey_id = $1 AND account_id = $2', [passkeyId, accountId])
      return row ? toLocked(row) : null
    },
    putLockedKey: async (accountId, passkeyId, key) => {
      const owned = await one(pool, 'SELECT 1 AS present FROM passkeys WHERE id = $1 AND account_id = $2', [passkeyId, accountId])
      if (!owned) return 'missing'
      await pool.query(
        `INSERT INTO locked_keys (passkey_id, account_id, kind, wrapped, salt) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (passkey_id) DO UPDATE SET kind = excluded.kind, wrapped = excluded.wrapped, salt = excluded.salt`,
        [passkeyId, accountId, key.kind, key.wrapped, key.salt],
      )
      return 'saved'
    },
    setRecoveryCode: async (accountId, authHash, key) => {
      await pool.query(
        `INSERT INTO recovery_codes (account_id, auth_hash, wrapped, salt) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE SET auth_hash = excluded.auth_hash, wrapped = excluded.wrapped, salt = excluded.salt`,
        [accountId, authHash, key.wrapped, key.salt],
      )
    },
    recoveryByCode: async (authHash) => {
      const row = await one(pool, 'SELECT account_id, wrapped, salt FROM recovery_codes WHERE auth_hash = $1', [authHash])
      return row ? { accountId: row.account_id as string, key: toLocked(row, 'recovery') } : null
    },
    setRecoveryWallets: (accountId, next) =>
      transaction(pool, async (client) => {
        await client.query('DELETE FROM recovery_wallet_addresses WHERE account_id = $1', [accountId])
        await client.query('DELETE FROM recovery_wallets WHERE account_id = $1', [accountId])
        if (!next) return
        await client.query('INSERT INTO recovery_wallets (account_id, threshold) VALUES ($1, $2)', [accountId, next.threshold])
        for (const address of next.addresses)
          await client.query('INSERT INTO recovery_wallet_addresses (account_id, address) VALUES ($1, $2)', [accountId, address])
      }),
    walletAccounts: async (addresses) => {
      if (addresses.length === 0) return []
      const found = await rows(
        pool,
        `SELECT a.account_id, w.threshold, COUNT(DISTINCT a.address) AS matched
         FROM recovery_wallet_addresses a JOIN recovery_wallets w ON w.account_id = a.account_id
         WHERE a.address = ANY($1::text[])
         GROUP BY a.account_id, w.threshold`,
        [addresses],
      )
      return found.map((row) => ({ accountId: row.account_id as string, threshold: row.threshold as number, matched: row.matched as number }))
    },
    createGrant: async (accountId) => {
      const token = randomBytes(32).toString('base64url')
      await pool.query('DELETE FROM recovery_grants WHERE expires_at <= $1', [now()])
      await pool.query('INSERT INTO recovery_grants (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), accountId, now() + GRANT_TTL_MS])
      return token
    },
    grant: async (token) => {
      if (!validGrant(token)) return null
      const row = await one(pool, 'SELECT account_id, expires_at FROM recovery_grants WHERE token_hash = $1', [sha256(token)])
      return row && (row.expires_at as number) > now() ? (row.account_id as string) : null
    },
    consumeGrant: async (token) => {
      if (!validGrant(token)) return null
      const row = await one(pool, 'DELETE FROM recovery_grants WHERE token_hash = $1 RETURNING account_id, expires_at', [sha256(token)])
      return row && (row.expires_at as number) > now() ? (row.account_id as string) : null
    },
    exportKeys: async (accountId) => {
      const keys = (await rows(pool, 'SELECT passkey_id, kind, wrapped, salt FROM locked_keys WHERE account_id = $1', [accountId])).map((row) => ({
        passkeyId: row.passkey_id as string,
        ...toLocked(row),
      }))
      const recovery = await one(pool, 'SELECT wrapped, salt FROM recovery_codes WHERE account_id = $1', [accountId])
      return { check: await check(accountId), keys, recovery: recovery ? toLocked(recovery, 'recovery') : null }
    },
    resetEncryption: (accountId) =>
      transaction(pool, async (client) => {
        await client.query('DELETE FROM docs WHERE account = $1', [accountId])
        await client.query('DELETE FROM account_usage WHERE account = $1', [accountId])
        await client.query('DELETE FROM locked_keys WHERE account_id = $1', [accountId])
        await client.query('DELETE FROM recovery_codes WHERE account_id = $1', [accountId])
        await client.query('DELETE FROM account_keys WHERE account_id = $1', [accountId])
      }),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

const createPgRateLimiter = (pool: pg.Pool, now: () => number = Date.now): RateLimiter => {
  let lastSweep = 0
  return {
    async hit(key, rule) {
      const at = now()
      if (at - lastSweep > 60 * 60 * 1000) {
        lastSweep = at
        void pool.query('DELETE FROM rate_limits WHERE window_start < $1', [at - DAY_MS]).catch(() => undefined)
      }
      const row = (await one(
        pool,
        `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           window_start = CASE WHEN rate_limits.window_start + $3 <= $2 THEN $2 ELSE rate_limits.window_start END,
           count = CASE WHEN rate_limits.window_start + $3 <= $2 THEN 1 ELSE rate_limits.count + 1 END
         RETURNING window_start, count`,
        [key, at, rule.windowMs],
      ))!
      const count = row.count as number
      if (count <= rule.limit) return { allowed: true, retryAfterMs: 0 }
      return { allowed: false, retryAfterMs: (row.window_start as number) + rule.windowMs - at }
    },
  }
}

export interface PostgresOptions {
  schema?: string
  max?: number
}

export const openPostgres = async (url: string, options: PostgresOptions = {}): Promise<Database> => {
  if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) throw new Error(`Invalid schema name: ${options.schema}`)
  const label = describeUrl(url)
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'lokhus',
    types,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  })
  pool.on('error', (error) => console.error(`${label}: ${withoutSecrets(error.message)}`))
  try {
    await pool.query('SELECT 1')
    await migrate(pool)
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw new Error(`Could not use ${label}: ${withoutSecrets(error instanceof Error ? error.message : String(error))}`)
  }
  return {
    kind: 'postgres',
    label,
    auth: (authOptions) => createPgAuthStore(pool, authOptions),
    vault: (now) => createPgVaultStore(pool, now),
    acknowledgments: (now) => createPgAcknowledgmentStore(pool, now),
    docStore: (account) => createPgDocStore(pool, account),
    limiter: (now) => createPgRateLimiter(pool, now),
    ping: async () => {
      await pool.query('SELECT 1')
    },
    close: () => pool.end(),
  }
}

const createPgAcknowledgmentStore = (pool: pg.Pool, now: () => number = Date.now): AcknowledgmentStore => {
  const findEligibility = async (accountId: string, version: number) => {
    const row = await one(pool, 'SELECT * FROM eligibility_confirmations WHERE account_id = $1 AND version = $2', [accountId, version])
    return row ? toEligibility(row) : null
  }
  const eligibility: Pick<AcknowledgmentStore, 'eligibility' | 'confirmEligibility' | 'listEligibility'> = {
    eligibility: findEligibility,
    confirmEligibility: async (accountId, version, statement) => {
      await pool.query(
        'INSERT INTO eligibility_confirmations (account_id, version, statement, confirmed_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [accountId, version, statement, iso(now())],
      )
      return (await findEligibility(accountId, version))!
    },
    listEligibility: async (accountId) =>
      (await rows(pool, 'SELECT * FROM eligibility_confirmations WHERE account_id = $1 ORDER BY version', [accountId])).map(toEligibility),
  }
  const get = async (accountId: string, kind: string, version: number) => {
    const row = await one(pool, 'SELECT * FROM acknowledgments WHERE account_id = $1 AND kind = $2 AND version = $3', [accountId, kind, version])
    return row ? toAcknowledgment(row) : null
  }
  return {
    get,
    add: async (accountId, ack) => {
      await pool.query(
        `INSERT INTO acknowledgments (account_id, kind, version, message, signature, signer, safe, chain_id, block_number, signed_date, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
        [accountId, ack.kind, ack.version, ack.message, ack.signature, ack.signer, ack.safe, ack.chainId, ack.blockNumber, ack.date, iso(now())],
      )
      return (await get(accountId, ack.kind, ack.version))!
    },
    list: async (accountId) =>
      (await rows(pool, 'SELECT * FROM acknowledgments WHERE account_id = $1 ORDER BY created_at, kind, version', [accountId])).map(toAcknowledgment),
    ...eligibility,
  }
}

export const withPostgresPool = async <T>(url: string, run: (pool: pg.Pool) => Promise<T>): Promise<T> => {
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5_000, application_name: 'lokhus-admin', types })
  try {
    return await run(pool)
  } finally {
    await pool.end()
  }
}

