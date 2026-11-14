# Postgres

Lokhus stores everything through a `Database` handle (`packages/server/src/database.ts`) with three parts the routes use: `DocStore` (`db.ts`, one per account), `AuthStore` (`auth.ts`) with `VaultStore` (`vault.ts`), and `RateLimiter` (`limits.ts`). There are two implementations:

- SQLite (`db.ts`, `auth.ts`, `vault.ts`, in-memory rate limits): used when `DATABASE_URL` is empty.
- Postgres (`postgres.ts`, the only module that imports `pg`): used when `DATABASE_URL` is set. `openDatabaseFromEnv` loads it lazily, so the SQLite path never touches `pg`.

## Connection

- One `pg.Pool` per process: 10 connections, 5 s connect timeout, 30 s idle timeout, `application_name=lokhus`.
- TLS comes from the URL. In `pg` 8.23, `sslmode=require` verifies the certificate like `verify-full`. Add `sslrootcert=` for a private CA.
- Startup runs `SELECT 1` and the migrations. Any failure ends the process with `Could not use Postgres at host:port/db: <reason>`. Credentials are stripped from every logged message.
- `int8` columns are parsed as JavaScript numbers. They hold millisecond timestamps, counters and byte counts, all far below 2^53.

## Migrations

`MIGRATIONS` in `postgres.ts` is an ordered list of SQL strings. On startup, inside one transaction holding `pg_advisory_xact_lock(hashtext(current_schema() || ':lokhus-migrations'))`, the server creates `schema_migrations` if needed and applies every version not yet recorded. Starting two servers at once is safe. To change the schema, append a new string; never edit an applied one.

## Tables (version 1)

```sql
CREATE FUNCTION lokhus_num(value text) RETURNS numeric IMMUTABLE
  -- the value as numeric, or NULL when it is not a plain number

docs (account text, collection text, id text, data jsonb, bytes integer, created_at timestamptz, updated_at timestamptz,
      PRIMARY KEY (account, collection, id))
  INDEX docs_by_created (account, collection, created_at, id)
  INDEX docs_activity_by_safe (account, collection, (data->>'safeId'), lokhus_num(data->>'blockNumber'), lokhus_num(data->>'logIndex'), id)
account_usage (account text PRIMARY KEY, bytes bigint)

accounts (id text PRIMARY KEY, name text, created_at text)
passkeys (id text PRIMARY KEY, account_id → accounts ON DELETE CASCADE, public_key bytea, counter bigint, transports text,
          rp_id text, name text, created_at text, last_used_at text)
sessions (token_hash text PRIMARY KEY, account_id → accounts CASCADE, created_at, expires_at, last_seen_at, step_up_at bigint, label text)
setup_code (singleton = 1, code_hash text, failures integer, locked_until bigint)
challenges (challenge text PRIMARY KEY, purpose, rp_id, account_id, account_name, expires_at bigint)

account_keys (account_id PRIMARY KEY → accounts CASCADE, key_check text, migrated boolean)
locked_keys (passkey_id PRIMARY KEY → passkeys CASCADE, account_id → accounts CASCADE, kind, wrapped, salt)
recovery_codes (account_id PRIMARY KEY → accounts CASCADE, auth_hash text UNIQUE, wrapped, salt)
recovery_wallets (account_id PRIMARY KEY → accounts CASCADE, threshold integer)
recovery_wallet_addresses (account_id → accounts CASCADE, address, PRIMARY KEY (account_id, address)), INDEX by address
recovery_grants (token_hash text PRIMARY KEY, account_id → accounts CASCADE, expires_at bigint)

rate_limits (key text PRIMARY KEY, window_start bigint, count integer), INDEX by window_start
```

Ids and timestamps keep the same types as in SQLite (text ids, ISO strings for account and passkey dates, millisecond numbers for sessions and challenges), so both implementations return identical values.

## Behaviour that matches SQLite

- **Filters:** `data->>'field' = $n`, comparing as text. Field names are checked against `FIELD_NAME` before they reach SQL.
- **Lists:** ordered by `created_at, id`. SQLite orders by `created_at, rowid`, which keeps insertion order for rows written in the same millisecond.
- **Keyset paging:**
  - Numeric sort fields go through `lokhus_num()`, the same expression as in the index, so a non-numeric value sorts as NULL instead of failing.
  - A row comparison `(k1, k2, id) < ($a, $b, $c)` follows the requested order, with NULLs placed as in SQLite: first ascending, last descending.
  - The query fetches `LIMIT n + 1` rows; the page size is capped at `PAGE_LIMIT_MAX`.
  - The cursor holds the last row's sort values. Malformed cursors throw `InvalidPageQuery`.
- **Quotas:**
  - Each doc stores its JSON size in `bytes`, so usage does not depend on how jsonb prints.
  - Writes lock the account's `account_usage` row (`FOR UPDATE`, created from `SUM(bytes)` if missing). They check the per-collection count for new ids and the byte limit, then upsert and update usage in the same transaction. Concurrent writes cannot overshoot.
- **Single use:**
  - Challenges and recovery grants are consumed with `DELETE ... RETURNING`.
  - The setup code is checked under `FOR UPDATE`, and `key_check` is only set while it is NULL.
- **Registration:** runs in one transaction under an advisory lock. In self mode it also moves `local` docs to the new account and deletes the setup code.
- **Passkey limits:** adding and removing passkeys lock the account row, so the passkey limit and "keep at least one" hold under concurrency.
- **Sessions:** stored as SHA-256 hashes. Creating one prunes the account's oldest sessions beyond the limit.
- **Encryption migration:** `removePlaintext(collection)` deletes the account's docs without an `enc` key (`NOT (data ? 'enc')`) and recomputes usage in the same transaction.
- **Account deletion:** `deleteAccount` removes the account's `docs`, `account_usage` and `challenges`, then the account; cascades clear passkeys, sessions, keys, recovery data and grants.
- **Rate limits:** one upsert per hit that starts a new window when the old one has passed, so all processes share the counters. Rows older than a day are swept at most once an hour per process.

## Moving from SQLite

`scripts/sqlite-to-postgres.ts` copies a SQLite database into an empty Postgres database in one transaction:
- **What it copies:** accounts, passkeys, sessions, the setup code, encryption and recovery data, and all docs with their sizes. Usage is recomputed afterwards.
- **Not copied:** challenges and recovery grants, which only last minutes.
- **Safety:** it refuses to write when the target already has accounts or docs. `--dry-run` runs everything and rolls back.

## Tests

`packages/server/src/testDatabases.ts` provides the backends the suites run against:
- **SQLite:** always runs.
- **Postgres:** runs only when `TEST_DATABASE_URL` is set, in the environment or in `.env`.
  - Each test opens its own `lokhus_test_<random>` schema through `search_path` and drops it afterwards.
  - The helper refuses a `TEST_DATABASE_URL` equal to `DATABASE_URL`.

`postgres.test.ts` adds Postgres-only checks:
- concurrent migrations
- rate limits shared between processes
- non-numeric sort fields
- the startup error without credentials
