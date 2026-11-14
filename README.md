# Lokhus

Personal multisig console for [Safe](https://safe.global) accounts. One person, several of their own keys: Lokhus shows what a transaction will do before you sign it, walks you through your signers one at a time, and talks to chains directly through RPCs. No Safe backend.

Use it at [lokhus.com](https://lokhus.com), where your data is end-to-end encrypted in the browser, or run it yourself with everything in a local SQLite file. Lokhus never holds keys; every transaction is signed on your own wallets.

[How Lokhus can fail, and what we do about it](https://lokhus.com/trust) lists the risks of the hosted app and how each is handled.

## Run

```sh
make run      # install, build, serve at http://localhost:8787
make dev      # API + Vite with hot reload at http://localhost:5173
make test     # unit tests
make check    # supply chain rules, registry signatures, docs drift (also run in CI)
make e2e      # deploy / sign / execute on local anvil forks of Polygon and Sonic (needs Foundry)
make reset-login  # remove all passkeys and sessions, keep your data
```

Settings live in `.env` at the repo root (gitignored). Copy `.env.example` and fill in what you need; every `make` target, `scripts/dev.sh` and the Vite build read it, and real environment variables win over the file. `.env.local` keeps working for the `VITE_` values.

```
VITE_WC_PROJECT_ID=...      # WalletConnect / Reown project id
DATABASE_URL=               # Postgres; leave empty to use the SQLite file
TEST_DATABASE_URL=          # optional, defaults to DATABASE_URL outside hosted mode
```

Without `DATABASE_URL`, data lives in `data/app.db` (gitignored). Back it up like any file.

## Postgres

Set `DATABASE_URL` to a Postgres 13+ connection string and start the server: it creates its tables on startup through versioned migrations (`schema_migrations`, guarded by an advisory lock, so two servers starting together are fine) and prints `Storage: Postgres at host:port/db`. It never prints the password. If the database cannot be reached, the server exits with a clear message instead of starting.

- TLS: `?sslmode=require` verifies the server certificate against the system CAs (`pg` treats it like `verify-full`). For a provider with its own CA, add `&sslrootcert=/path/to/ca.pem`. `uselibpqcompat=true&sslmode=require` encrypts without verifying; avoid it outside a private network.
- Rate limits are stored in Postgres too, so several server processes share them.
- Moving an existing SQLite database: `DATABASE_URL=... node --env-file-if-exists=.env scripts/sqlite-to-postgres.ts [--from data/app.db] [--dry-run]`. It copies accounts, passkeys, sessions, encryption and recovery data, signed acknowledgments and all documents in one transaction, refuses to write into a database that already has accounts or documents, and `--dry-run` checks everything without writing.
- Tests: with `TEST_DATABASE_URL` set (in the environment or `.env`), the server test suites also run against Postgres. Each run creates its own `lokhus_test_*` schema and drops it afterwards, so your dev database is fine. Without `TEST_DATABASE_URL` the tests use `DATABASE_URL`, except in hosted mode. Never run them against production.

## Signing in

Lokhus signs you in with a passkey (Touch ID, Face ID, a phone or a security key). Open it at `http://localhost:8787`: passkeys do not work on a raw IP, so `127.0.0.1` redirects to `localhost`.

- On first start the server prints a one-time link (`http://localhost:8787/signin?setup=…`). Open it to create your account and its first passkey. Anything already in the database moves into that account. After that, nobody else can register.
- Add a second passkey in Settings so one lost device does not lock you out.
- Lost every passkey? On the machine running Lokhus, run `make reset-login` and open the one-time link it prints to create a new passkey. No restart needed. Your Safes, signers and notes stay.
- To use Lokhus under another hostname later (for example through Tailscale with https), list it in `LOKHUS_HOSTS=name.example.ts.net`. Passkeys are tied to the hostname, so add a passkey for the new host while signed in on the old one.

## Hosting

Lokhus runs in one of two modes, set with `LOKHUS_MODE`:

- `self` (default): one person on their own machine. Registration needs the one-time setup link, the first account adopts existing data, and `make reset-login` works.
- `hosted`: a public site. Anyone can create an account with a passkey, each account starts empty, and there is no setup code. `make reset-login` refuses to run, since it would affect every user.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOKHUS_MODE` | `self` | `self` or `hosted` |
| `LOKHUS_HOSTS` | | Comma-separated hostnames, for example `lokhus.com`. Required in hosted mode; passkeys there need https. |
| `LOKHUS_BIND` | `127.0.0.1` | Address to listen on. Keep it on loopback behind a reverse proxy. |
| `LOKHUS_TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so `X-Forwarded-For` / `X-Forwarded-Proto` are used for the client IP, `Secure` cookies and HSTS. Never set it when the server is reachable directly. |
| `LOKHUS_PROXY_HOPS` | `1` | How many trusted proxies append to `X-Forwarded-For`. The client IP is taken that many entries from the right. Raise it only if every hop is a proxy you control and that appends. |
| `LOKHUS_DEV_LOCALHOST` | off | Allow `http://localhost` in hosted mode, for local testing only. |
| `PORT_API` | `8787` | Port. |
| `DATABASE_URL` | | Postgres connection string. Empty means SQLite. |
| `MSA_DB` | `data/app.db` | SQLite file, used when `DATABASE_URL` is empty. |

Hosted deployment on one box: Caddy terminates TLS and proxies to Lokhus on `127.0.0.1:8787` (`deploy/Caddyfile`), and systemd runs the server (`deploy/lokhus.service`). Put the settings, including `DATABASE_URL`, in `/etc/lokhus/lokhus.env` (owned by root, mode `0640`, group `lokhus`); the unit loads it with `EnvironmentFile=`. Back up the database (`pg_dump` or your provider's backups). The schema is described in `docs/postgres.md`.

Every response carries a strict Content Security Policy (scripts, styles and fonts only from the site itself), `frame-ancestors 'none'`, `nosniff`, `no-referrer`, a Permissions-Policy that only allows WebUSB (Ledger), and HSTS over https. Sign-up, sign-in and writes are rate limited; each account has quotas on request size (256 KB), documents (200,000 activity items, 5,000 of anything else), total storage (50 MB), passkeys (10) and sessions (20).

## Deploy on Coolify

The repo ships a `Dockerfile` (multi-stage, pinned `node:24.22.3-bookworm-slim` by digest, runs as the unprivileged `node` user) and a `docker-compose.yml`. Database migrations run automatically when the container starts.

1. In Coolify, create a new resource from this Git repository with the **Dockerfile** build pack (or **Docker Compose** with `docker-compose.yml`).
2. **Ports Exposes:** `8787`. Leave **Ports Mappings** empty, so the app is reachable only through Coolify's proxy and never directly on the host. The container listens on `0.0.0.0:8787`, which is only reachable on the Docker network.
3. **Domain:** `https://lokhus.com`. Coolify's Traefik terminates TLS.
4. **Health check path:** `/healthz` (port 8787). It answers `{ "ok": true }`, or 503 when the database is unreachable, and shows nothing else.
5. **Environment variables:**
   - `DATABASE_URL`: your production Postgres. If the database is a Coolify resource in the same project, use its internal URL (the container name as host); otherwise turn on **Connect to Predefined Network** on both so they share the Docker network. Add `?sslmode=require` when the connection leaves the server.
   - `LOKHUS_MODE=hosted`, `LOKHUS_HOSTS=lokhus.com`, `LOKHUS_TRUST_PROXY=1` (the image defaults to hosted mode and trusting the proxy; set them anyway so it is explicit).
   - `VITE_WC_PROJECT_ID`: mark it as a **build variable**. It is compiled into the web app.
6. In the Reown (WalletConnect) dashboard, add `https://lokhus.com` to the allowed origins.
7. **Container labels:** add a per-IP rate limit and send `www` to the apex domain, then list both middlewares on the https routers (`<id>` is the router suffix Coolify generates):
   ```
   traefik.http.middlewares.lokhus-rl.ratelimit.average=20
   traefik.http.middlewares.lokhus-rl.ratelimit.burst=100
   traefik.http.middlewares.www-to-apex.redirectregex.regex=^https?://www\.lokhus\.com/(.*)
   traefik.http.middlewares.www-to-apex.redirectregex.replacement=https://lokhus.com/${1}
   traefik.http.routers.https-0-<id>.middlewares=gzip-sse,lokhus-rl
   traefik.http.routers.https-1-<id>.middlewares=www-to-apex,gzip-sse,lokhus-rl
   ```
   Label changes need a Redeploy, not a Restart.

If something else on the host already listens on 443 (for example Tailscale Funnel on the tailnet address), bind Coolify's proxy to the public IP only (`'<public-ip>:443:443'` in the proxy configuration) instead of `0.0.0.0`.

DNS: keep the records **DNS only**, so TLS ends on your server. Turn on DNSSEC, and add a CAA record allowing only Let's Encrypt (`0 issue "letsencrypt.org"`). With Universal SSL on, Cloudflare adds its own CAs to the CAA answer; turn it off when nothing is proxied.

Client IPs (for rate limits) come from `X-Forwarded-For`, which Traefik appends. With Cloudflare's proxy (orange cloud) in front, the rightmost address is a Cloudflare server, so every visitor would share one rate limit. Either keep the DNS record **DNS only**, or configure Traefik's `forwardedHeaders.trustedIPs` with Cloudflare's ranges and set `LOKHUS_PROXY_HOPS=2`. Never raise the hop count without that: clients can put any address in the header themselves.

Local test with a throwaway Postgres (published on `127.0.0.1` only):

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

That runs in self mode at `http://localhost:8787`; the setup link is in the container log.

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | Safe logic (build, hash, sign, execute), plugin interfaces, storage interface. No UI, no server assumptions. |
| `packages/server` | Tiny HTTP server: JSON document store on `node:sqlite` or Postgres (`DATABASE_URL`), passkey auth, serves the built web app. |
| `packages/web` | React UI, wallet plugins, HTTP storage adapter. |

## Extending

- **Chains** are data: add them under Settings, Chains (RPCs are verified on save).
- **Wallets** implement `WalletPlugin` (`packages/core/src/plugins.ts`) and register in `packages/web/src/plugins.ts`.
- **Actions** implement `ActionPlugin`: declare fields, return one or more calls. Several calls are batched through MultiSendCallOnly automatically.
- **Storage** implements `Storage`; swap `createHttpStorage` for another adapter (IndexedDB, hosted API) without touching pages.

## Security notes

- The server binds to `127.0.0.1`, rejects foreign `Host` headers and cross-site requests, and requires a custom header on writes.
- Every `/api` call needs a session. The session cookie is HttpOnly and SameSite=Strict, and the server stores only a hash of it.
- `npm` install scripts are disabled (`.npmrc`).
- Ledger signs Safe transactions as EIP-712 hashes. Compare the domain and message hash on the transaction page with the device. Executing needs blind signing enabled in the Ethereum app.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Contributing

The code is public so anyone can read and audit it. Issues, discussions and pull requests are closed: this is a small project handling funds, and a public inbox mostly attracts spam and social engineering. Security reports go to security@lokhus.com.

## Licence

[Functional Source License 1.1, Apache 2.0 future licence](LICENSE.md). You can read, run, modify and self-host Lokhus for yourself or your organisation, but not offer it as a competing service. Each release becomes Apache 2.0 two years after it is published.

WalletConnect (Reown AppKit) ships under its own community licence, which is free up to 500 monthly active wallets or 2.5M monthly RPC calls. A busy deployment needs a commercial licence from Reown.
