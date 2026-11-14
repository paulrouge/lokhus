# Lokhus

Personal console for Safe multisig accounts. Runs locally: a tiny Node server stores app data in SQLite and serves a React UI that talks to chains directly over RPC. No Safe backend, no third-party services besides public RPCs and the WalletConnect relay.

This app moves real funds. Correctness of anything that gets hashed, signed or executed matters more than anything else here.

## Who it is for

A personal multisig: one person owns every signer (hardware wallets, card, phone and browser wallets) and uses the Safe to protect their own funds against a single lost or stolen key. It is not a team treasury tool where different people sign. Design follows from that:

- Signing means one person switching between their own signers in one sitting (switch-signer hint, short swap signing windows).
- Each account is one person. Self-hosted, data stays on their machine; hosted (lokhus.com), each account sees only its own data. There is no shared queue, co-signer invites, proposal sharing or notifications.
- Guidance (Best practice, Security) speaks to one person's keys and backups, not company key ceremonies.

Do not add multi-person features unless asked; if a change would only make sense for teams, raise it first.

## Commands

```sh
make run        # npm ci (if needed), build web, serve at http://localhost:8787
make dev        # API (node --watch) + Vite on http://localhost:5173, /api proxied
make test       # vitest unit tests
make typecheck  # tsc for core, server, web
make check      # supply chain rules, npm registry signatures, docs drift (CI runs this too)
make e2e        # deploy / sign / execute / activity on anvil forks of Polygon and Sonic (needs Foundry)
make reset-login  # delete all passkeys and sessions, keep accounts and data
```

The user runs the long-lived servers (`make run`, `make dev`). Don't start them yourself; if you need a server to verify something, start one on a spare port with a temp DB (`MSA_DB=/tmp/x.db PORT_API=18xxx node packages/server/src/index.ts`) and stop it afterwards.

## Layout

npm workspaces, three packages:

- `packages/core`: framework-agnostic TypeScript. Types, `Storage` interface, plugin interfaces (`WalletPlugin`, `ActionPlugin`, `Registry`), Safe logic (`safe/tx.ts` build/hash/sign/exec encoding, `safe/deploy.ts` via Protocol Kit, `safe/onchain.ts` reads, `safe/activity.ts` log scanning), built-in actions, default chains and seeding. No React, no server assumptions.
- `packages/server`: plain `node:http` + `node:sqlite` or Postgres (`DATABASE_URL`), run directly as TypeScript via Node type stripping (no build). Generic JSON document store (`docs` table: account, collection, id, data) exposed as `/api/:collection[/:id]`, passkey auth under `/api/auth/*` (`auth.ts` store, `authRoutes.ts`), plus static serving of `packages/web/dist`. `app.ts` builds the request handler so tests can run it.
- `packages/web`: Vite + React 19 + react-router. Wallet plugins (`wallets/`), HTTP storage adapter, pages, one stylesheet.

## Architecture rules

- **Storage is an interface.** Pages only touch `useStorage()` / `useCollection()` / `useDoc()`. Never call `fetch('/api…')` from UI code. A Postgres or IndexedDB backend must be swappable without touching pages.
- **Collections** are declared once in `core/src/storage.ts` (`CollectionMap` + `COLLECTIONS`). The server whitelists from that list, so adding a collection means adding it there.
- **Every persisted value is JSON-safe.** Bigints (amounts, nonces, block numbers) are stored as decimal strings and converted at the edges.
- **IDs:** owners use the lowercase address, chains the chain id string, txs the safeTxHash, activity `chainId:txHash:logIndex`, notes `entityType:entityId` (general notes use a uuid), created Safes a uuid and imported Safes `chainId:address`.
- **Plugins:** a new wallet implements `WalletPlugin` and is registered in `web/src/plugins.ts`. A new action implements `ActionPlugin` (declares fields, returns `calls`); multiple calls are batched through MultiSendCallOnly automatically by `buildSafeTx`. Chains are data, edited in the UI, not code.
- **The server imports only `@msa/core/storage`** (types plus `COLLECTIONS`) **, `@msa/core/acknowledgment`** (the signed statement text, no imports of its own) **, `@simplewebauthn/server`** for passkeys, **`@noble/curves` + `@noble/hashes`** (pinned, for recovery-wallet signatures in `walletSignature.ts`) **and `pg`** (pinned, imported only by `postgres.ts`, which `database.ts` loads lazily when `DATABASE_URL` is set). Keep it that way: it runs under Node type stripping, so no enums, no parameter properties, no non-erasable TS, and relative imports need `.ts` extensions.

## Safe-specific invariants

- Safe tx hashing and signing live in `core/src/safe/tx.ts` and are tested against Protocol Kit (`calculateSafeTransactionHash`, `encodeMultiSendData`). Any change there needs those tests green plus `make e2e`.
- Signatures are EIP-712 (`eth_signTypedData_v4`), verified with `recoverSafeTxSigner` before storing, and packed sorted by signer address ascending.
- `safeTxGas`, `baseGas` and `gasPrice` are always 0, so a failing inner call reverts the whole `execTransaction`.
- Ledger signs via `signEIP712HashedMessage`. `wallets/typedDataHashes.ts` rebuilds domain and message hashes from the JSON a wallet receives, and its test proves the result equals the Safe tx hash. Executing or deploying from a Ledger needs Blind signing enabled in the Ethereum app.
- Activity scanning stores `scannedBlock` per Safe and only scans new blocks. Token transfers are queried only for the chain's listed tokens (public RPCs reject topic-only getLogs) and ranges stay under 10k blocks. Use `getBlockNumber({ cacheTime: 0 })`: viem caches it for ~4s, and stale values made scans miss fresh transactions.
- The chain's token list is also the spam whitelist: incoming transfers of unlisted tokens and zero-value transfers (address poisoning) are hidden in Activity, and balances only show listed tokens.

## SODAX swaps

- `core/src/actions/sodax.ts` calls the SODAX HTTP API (`/quote`, `/intents`, `/submit-tx`), never the SDK. Same-chain only: any two tokens from SODAX's `/tokens/<chainKey>` list for the Safe's chain. The token list is display data: decimals are re-read onchain, and on spoke chains each token's hub asset is read from the hub AssetManager (`assets(relayId, token)`) on Sonic, never taken from the API. Token icons load from SODAX's assets repo (`sodaxTokenLogo`).
- Never trust the API response. The calldata is decoded locally and refused unless: it targets the pinned SODAX contract, source and destination chain equal the Safe's chain, source and destination address are the Safe, tokens, amount, minimum output and deadline match the request, no fee, solver or hook data, the intent creator equals the Safe's hub wallet read onchain on Sonic, and the API's reported intent equals the decoded one. The minimum output never drops below the one the swap form showed (`seenQuote`); a lower quote at build is refused. `sodax.test.ts` covers each refusal; keep it green when touching this.
- After execution the Safe tx hash is reported via `/submit-tx` (`afterExecute`), and TxView can resend it or poll the status. When the swaps API can't say filled or failed, the status is read onchain on Sonic: the intent is decoded from the executed calls, hashed (`keccak256(abi.encode(intent))`), checked in `intentStates`, and once gone matched to an `IntentFilled` or `IntentCancelled` log scanned from the block that created it (the Safe tx on Sonic, the relay's `dst_tx_hash` on spokes).

## Security

- Server binds `LOKHUS_BIND` (default `127.0.0.1`), rejects foreign `Host` headers (DNS rebinding), rejects cross-site `Sec-Fetch-Site`, and requires `X-MSA: 1` on writes. Don't loosen these. Extra hostnames come only from `LOKHUS_HOSTS`.
- Modes (`LOKHUS_MODE`, parsed in `config.ts`): `self` (default; setup code, first account adopts `local` docs, `make reset-login`) and `hosted` (open passkey sign-up, every account starts empty, no setup code, reset-login refuses, needs `LOKHUS_HOSTS` and https unless `LOKHUS_DEV_LOCALHOST=1`). `localhost` is accepted only in self mode or with that flag.
- `X-Forwarded-For` / `X-Forwarded-Proto` are read only with `LOKHUS_TRUST_PROXY=1`: the proto from the rightmost value, the client IP `LOKHUS_PROXY_HOPS` (default 1) entries from the right. They decide the client IP for rate limits, the `Secure` cookie flag and HSTS.
- Limits live in `config.ts` (`DEFAULT_LIMITS`): body sizes, docs per collection, bytes per account (tracked in `account_usage`), passkeys and sessions per account, and rate limits per IP on `/api/auth/*` (tighter on sign-up) and per account on writes. Errors are 413, 507 and 429 with `Retry-After`.
- `GET /healthz` (exact path) is the only route exempt from the Host check: it pings the database and answers `{ ok }` (200 or 503), nothing else, with the usual security headers.
- Docker: `Dockerfile` (pinned base by digest, non-root `node` user, `LOKHUS_BIND=0.0.0.0` only inside the container, `HEALTHCHECK` on `/healthz`), `docker-compose.yml` (uses `expose`, never `ports`, read-only root filesystem) and `docker-compose.local.yml` (throwaway Postgres, host port on `127.0.0.1` only). The server shuts down cleanly on SIGTERM. Never publish the container port on a public interface.
- `headers.ts` sets the CSP and other security headers on every response. The app needs no `'unsafe-inline'`; keep it that way. New external hosts (images, frames, sockets) must be added there deliberately.
- Storage behind the server is a `Database` handle (`database.ts`) giving `DocStore`, `AuthStore`, `VaultStore` and `RateLimiter`. SQLite (with in-memory rate limits) when `DATABASE_URL` is empty, Postgres (`postgres.ts`, versioned migrations under an advisory lock, shared rate limits) when it is set. Both must behave the same: the server test suites run against both (`testDatabases.ts`; Postgres with `TEST_DATABASE_URL`, or `DATABASE_URL` outside hosted mode, each test in its own throwaway `lokhus_test_*` schema). Schema changes are new entries in `MIGRATIONS`, never edits to applied ones. `docs/postgres.md` has the details.
- Login is passkey only (`@simplewebauthn/server` / `browser`). Accounts, passkeys, sessions and challenges live in their own SQLite tables, never in `docs` and never reachable through `/api/:collection`. Every `/api` route except status, register, login and logout needs a session; doc queries are scoped to the session's account.
- Sessions: 32 random bytes in an HttpOnly, SameSite=Strict cookie (`Secure` behind https), stored as a SHA-256 hash, 30 days sliding. Challenges are single use, bound to purpose and RP ID, and expire after 5 minutes.
- Passkeys need a hostname: `127.0.0.1` page requests redirect to `localhost`. The RP ID and expected origin come from the request `Origin`, which must be `http://localhost:*` or `https://` on a `LOKHUS_HOSTS` name.
- In self mode, registration is open only while no account exists, or after `make reset-login` (then it attaches to the existing account), and it needs a one-time setup code: 10 chars, stored only as a hash, printed as a link by the server at startup and by `make reset-login`, compared in constant time, locked for a minute after 5 wrong tries, and deleted once a passkey is registered. The first account takes over docs stored under the legacy `local` account. In hosted mode each person has their own account; there is no sharing between accounts.
- **End-to-end encryption** (`web/src/crypto/`, `web/src/lib/vault.ts`): each account has one random 256-bit data key, made in the browser. The server stores it only locked: per passkey (AES-GCM under an HKDF key from the WebAuthn PRF secret, or a PBKDF2-SHA256 600k passphrase when the authenticator has no PRF) in `locked_keys`, and under the recovery code in `recovery_codes`. The browser holds working keys as non-extractable `CryptoKey`s; the raw data key exists only sealed under a non-extractable device key (in IndexedDB when "stay unlocked" is on, else in memory) and is unsealed briefly to lock it for a new passkey or recovery code. PRF output never leaves the browser (`takePrf` strips it from responses).
- Docs are encrypted in the storage adapter (`createEncryptedStorage`), so pages are unchanged: `{ id: HMAC(id), v: 1, enc: AES-GCM(json, aad = collection/hiddenId) }` plus only `INDEXED_FIELDS` as HMACs (filters: `safeId`, `status`, `entityType`, `entityId`) and `SORT_FIELDS` in clear (`blockNumber`, `logIndex`). Filtering on any other field throws; add new filter fields to `INDEXED_FIELDS`. The server sees collection names, hidden ids, hidden filter values, block numbers, sizes and timestamps, never contents (the one readable exception is `acknowledgments`, below). Existing plaintext docs are encrypted once, only by the browser that created the key (`encryptPlaintextDocs`, idempotent, waits out 429s, never overwrites an encrypted doc), then `account_keys.migrated` is set. Once `key_check` is set the server refuses docs without `enc`. Plaintext `activity` is not encrypted but deleted in bulk (`DELETE /api/activity?_plaintext=1`, only docs without `enc`) and Safes lose `scannedBlock`, so activity rescans from the chain; SODAX follow-ups live on `txs` and survive. `account_keys.key_check` (an HMAC under the id key) is set once and stops two browsers from creating different keys.
- **Recovery**: a 25-char recovery code (125 bits) splits via HKDF into an auth secret (server keeps a hash; it finds the account and grants one new passkey) and a lock key for the data key. Recovery wallets (M of N addresses, EIP-191 signatures over a single-use server challenge) recover access only; data then needs the recovery code. Recovery grants last 10 minutes and are single use. Without passkey key, code or wallets the data cannot be decrypted, also not by the operator; "start over" (`keys/reset`) deletes it.
- **Acknowledgments** (`core/src/acknowledgment.ts`, `server/src/acknowledgments.ts`, `web/src/actions/StocksAcknowledgment.tsx`): hosted mode only (self mode shows no gate; the GET answers `required: false` and the POST is a 404): before the first stock trade, one Safe owner signs an EIP-191 statement (risks, no liability, legality is the user's job) naming signer, Safe, chain, block and date. The browser checks the signer is an owner at that block and an EOA; the server rebuilds the message from the fields, refuses any other text, a date more than an hour off or a signature from anyone else, and stores it readable in its own `acknowledgments` table (not `docs`, not encrypted: it is the operator's record), one per account, kind and version, first one wins, under `/api/auth/acknowledgments`. It is in the export and deleted with the account, not by start-over. Changing the text means bumping `version` in `ACKNOWLEDGMENTS`, which asks everyone again.
- **Step-up**: sessions record `step_up_at` (set at sign-in and by `stepup/verify`). Adding or removing passkeys, replacing a locked key, changing the recovery code or wallets, export, start-over and account deletion need one within 5 minutes; the API answers 403 `code: step_up` and the web client confirms with a passkey and retries.
- `make reset-login` also drops every passkey's locked key; afterwards encrypted data needs the recovery code.
- `.npmrc` sets `ignore-scripts=true` and `save-exact=true`. Keep install scripts off; add dependencies deliberately and check `npm audit` afterwards. `scripts/check-supply-chain.ts` enforces exact versions, registry-only sha512 lock entries and a licence allowlist; extend the allowlist only after reading the new licence.
- `scripts/check-docs.ts` fails when README or CLAUDE.md drift from the code: env vars, `make` targets, file paths and the quota numbers in README. Fix the docs, not the check.
- Never put secrets, seed phrases or key locations in code, fixtures or the DB.
- `/trust` (`web/src/pages/Trust.tsx`) publicly lists each risk of the hosted app and what handles it. When a change adds, removes or weakens one of those measures, update that page in the same change so it never claims more than is true.
- In fork tests, never send to addresses derived from well-known test keys: on mainnet forks they are often EIP-7702 delegated to sweeper bots. Use `generatePrivateKey()` for recipients.

## Environment

- `.env` at the repo root (gitignored; template in `.env.example`): `DATABASE_URL`, `TEST_DATABASE_URL`, `LOKHUS_*`, `VITE_WC_PROJECT_ID`. Make targets and `scripts/dev.sh` load it with `--env-file-if-exists=.env`, Vite reads it from the root (`envDir`), and real environment variables win. `.env.local` still works for `VITE_` values.
- `APP_PORT` (Makefile) / `PORT_API` (server) pick the port. Not `PORT`: the user's shell already sets that.
- Without `DATABASE_URL`, data lives in `data/app.db` (gitignored, WAL mode). `scripts/sqlite-to-postgres.ts` copies it into an empty Postgres database.

## Style

- No comments by default. Names and structure carry intent; one short line only when unavoidable.
- UI: light theme, calm and professional with small accents. All tokens are CSS variables at the top of `web/src/styles.css`; reuse the existing classes (`card`, `btn-*`, `badge-*`, `stack`, `row`, `gap-*`) and components in `components/ui.tsx` rather than adding a UI library.
- Prettier-ish formatting: 2 spaces, single quotes, no semicolons, ~130 columns.

## Repository and licence

- GitHub `paulrouge/lokhus`, public as read-only source: issues, discussions, wiki and outside pull requests stay off; reports go to security@lokhus.com (`SECURITY.md`). Everything pushed here is public at once: never commit secrets, `.env`, `data/` or `internal/`. History before the public release lives in the private `paulrouge/lokhus-private` (archived).
- Licence: FSL-1.1-ALv2 (`LICENSE.md`), also set in every `package.json`. New dependencies must allow that; check their licence, not only `npm audit`. Reown/WalletConnect has its own licence with a free tier of 500 MAU / 2.5M RPC calls a month.

## Roadmap

- Generic contract-call action (saved contracts with ABI) and a SODAX money-market deposit plugin (`@sodax/sdk` is heavy; keep it isolated in its own package).
- Owner and threshold management actions.
- Going public at lokhus.com: account recovery with recovery keys, export and deletion, end-to-end encryption of account data, Postgres stores, backups, release integrity.

## SODAX money market (supply / withdraw)

- No HTTP API for building lending txs yet, so `actions/sodaxLend.ts` encodes the calls itself, mirroring SDK 2.2 `buildSupplyData` / `buildWithdrawData`.
- Rates, token lists and hub/vault mapping come from `api.sodax.com/v1/be` (`/config/money-market/{chainKey}/tokens`, `/config/all`, `/moneymarket/asset/all`); everything that moves funds is re-checked onchain: hub asset via the hub AssetManager, vault listed in the pool's `getReservesList`, vault `tokenInfo` supported with zero fees.
- Positions are read onchain: aToken `balanceOf(hub wallet)` on Sonic, in 18 decimals.
- Polygon: supply = AssetManager.transfer with hub payload, withdraw = Connection.sendMessage; both are relayed (`POST /v1/relay` submit, `get_transaction_packets` for status). Sonic: everything goes through the wallet router `route()` and settles in the same tx.
- Fork e2e proves the full Sonic round trip; the Polygon hub leg can only be checked live.
