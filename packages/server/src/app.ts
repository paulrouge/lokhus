import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { COLLECTIONS, type CollectionName } from '@msa/core/storage'
import { InvalidPageQuery, QuotaExceeded, type DocStore } from './db.ts'
import { parseListQuery } from './query.ts'
import { HttpError, isSecureRequest, readBody, readCookie, send } from './http.ts'
import { SESSION_COOKIE, type AuthStore } from './auth.ts'
import type { VaultStore } from './vault.ts'
import type { AcknowledgmentStore } from './acknowledgments.ts'
import type { Database } from './database.ts'
import { currentSession, handleAuth, rateLimit, simpleWebAuthn, type WebAuthn } from './authRoutes.ts'
import type { ServerConfig } from './config.ts'
import type { RateLimiter } from './limits.ts'
import { securityHeaders } from './headers.ts'

export interface AppOptions {
  database: Database
  config: ServerConfig
  staticDir: string
  webauthn?: WebAuthn
  now?: () => number
  auth?: AuthStore
  vault?: VaultStore
  acknowledgments?: AcknowledgmentStore
  docStore?: (account: string) => DocStore
  limiter?: RateLimiter
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
}

const PRERENDERED = new Set(['/welcome', '/trust', '/security', '/best-practice'])

const SELF_ROBOTS = 'User-agent: *\nDisallow: /\n'

export const createApp = (options: AppOptions) => {
  const { database, config, staticDir } = options
  const { port, limits } = config
  const auth = options.auth ?? database.auth({ mode: config.mode, now: options.now, limits })
  const vault = options.vault ?? database.vault(options.now)
  const acknowledgments = options.acknowledgments ?? database.acknowledgments(options.now)
  const webauthn = options.webauthn ?? simpleWebAuthn
  const limiter = options.limiter ?? database.limiter(options.now)
  const loopback = `127.0.0.1:${port}`
  const allowedHosts = new Set([
    ...(config.allowLocalhost ? [loopback, `localhost:${port}`] : []),
    ...config.hosts.flatMap((host) => [host, `${host}:${port}`]),
  ])
  const stores = new Map<string, DocStore>()
  const storeFor = (account: string) => {
    let store = stores.get(account)
    if (!store) {
      store = options.docStore ? options.docStore(account) : database.docStore(account)
      stores.set(account, store)
    }
    return store
  }

  const isTrustedRequest = (req: IncomingMessage) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return false
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return false
    if (req.method !== 'GET' && req.headers['x-msa'] !== '1') return false
    return true
  }

  const handleDocs = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const session = await currentSession(req, res, auth, config.trustProxy)
    if (!session) throw new HttpError(401, 'Sign in first')
    const store = storeFor(session.accountId)
    const [, , collectionName, rawId, ...rest] = url.pathname.split('/')
    if (rest.length > 0) throw new HttpError(404, 'Not found')
    if (!collectionName || !COLLECTIONS.includes(collectionName as CollectionName)) throw new HttpError(404, 'Unknown collection')
    const collection = collectionName as CollectionName
    const id = rawId ? decodeURIComponent(rawId) : undefined

    if (req.method === 'GET' && !id) {
      const parsed = parseListQuery(url.searchParams)
      return send(res, 200, parsed.kind === 'page' ? await store.page(collection, parsed.query) : await store.list(collection, parsed.filter))
    }
    if (req.method === 'DELETE' && !id && url.searchParams.get('_plaintext') === '1') {
      await rateLimit(limiter, `writes:${session.accountId}`, limits.writesPerMinute, 60_000)
      return send(res, 200, { removed: await store.removePlaintext(collection) })
    }
    if (!id) throw new HttpError(405, 'Method not allowed')

    if (req.method === 'GET') {
      const doc = await store.get(collection, id)
      return doc ? send(res, 200, doc) : send(res, 404, { error: 'Not found' })
    }
    if (req.method !== 'PUT' && req.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
    await rateLimit(limiter, `writes:${session.accountId}`, limits.writesPerMinute, 60_000)
    if (req.method === 'PUT') {
      const body = await readBody(req, limits.docBodyBytes)
      if (!body || typeof body !== 'object' || (body as { id?: unknown }).id !== id) {
        throw new HttpError(400, 'Body must be an object whose id matches the URL')
      }
      if (typeof (body as { enc?: unknown }).enc !== 'string' && (await vault.status(session.accountId)).check)
        throw new HttpError(400, 'This account is encrypted: documents must be encrypted')
      const maxDocs = collection === 'activity' ? limits.activityDocs : limits.docsPerCollection
      return send(res, 200, await store.put(collection, body as never, { maxDocs, maxAccountBytes: limits.accountBytes }))
    }
    await store.remove(collection, id)
    return send(res, 204)
  }

  const prerenderedFile = (req: IncomingMessage, pathname: string) => {
    if (config.mode !== 'hosted' || readCookie(req, SESSION_COOKIE)) return null
    const page = pathname === '/' ? '/welcome' : pathname
    return PRERENDERED.has(page) ? join(staticDir, 'prerendered', `${page.slice(1)}.html`) : null
  }

  const handleStatic = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (config.mode === 'self' && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': MIME['.txt'], 'Cache-Control': 'no-cache' }).end(SELF_ROBOTS)
      return
    }
    const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(staticDir, requested)
    if (!file.startsWith(staticDir)) throw new HttpError(403, 'Forbidden')

    const info = await stat(file).catch(() => null)
    if (!info || info.isDirectory()) {
      const prerendered = prerenderedFile(req, url.pathname)
      file = prerendered && (await stat(prerendered).catch(() => null)) ? prerendered : join(staticDir, 'index.html')
    }

    const content = await readFile(file).catch(() => null)
    if (!content) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Web app not built yet. Run `make run`.')
      return
    }
    const cache = file.includes(`${join(staticDir, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
    const hosted = config.mode === 'hosted'
    res
      .writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': cache,
        ...(hosted && file !== join(staticDir, 'index.html') ? {} : { 'X-Robots-Tag': 'noindex' }),
        ...(hosted && extname(file) === '.html' ? { Vary: 'Cookie' } : {}),
      })
      .end(content)
  }

  const health = async (res: ServerResponse) => {
    const ok = await database.ping().then(
      () => true,
      () => false,
    )
    send(res, ok ? 200 : 503, { ok })
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(securityHeaders(config, isSecureRequest(req, config.trustProxy)))) res.setHeader(name, value)
    try {
      if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return await health(res)
      if (!isTrustedRequest(req)) throw new HttpError(403, 'Forbidden')
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname.startsWith('/api/auth/'))
        return await handleAuth(req, res, url.pathname.slice('/api/auth/'.length), { auth, vault, acknowledgments, webauthn, config, limiter, now: options.now ?? Date.now, storeFor })
      if (url.pathname.startsWith('/api/')) return await handleDocs(req, res, url)
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed')
      if (req.headers.host === loopback) {
        res.writeHead(302, { Location: `http://localhost:${port}${url.pathname}${url.search}` }).end()
        return
      }
      return await handleStatic(req, res, url)
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof QuotaExceeded
            ? 507
            : error instanceof SyntaxError || error instanceof InvalidPageQuery || error instanceof URIError
              ? 400
              : 500
      if (status === 500) console.error(error)
      const retryAfter: Record<string, string> =
        error instanceof HttpError && error.retryAfterSeconds !== null ? { 'Retry-After': String(error.retryAfterSeconds) } : {}
      const code = error instanceof HttpError && error.code ? { code: error.code } : {}
      send(res, status, { error: status === 500 ? 'Unexpected error' : error instanceof Error ? error.message : 'Unexpected error', ...code }, retryAfter)
    }
  }
}
