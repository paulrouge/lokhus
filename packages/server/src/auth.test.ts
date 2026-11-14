import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, SETUP_LOCK_MS, hashToken } from './auth.ts'
import { securityHeaders } from './headers.ts'
import { GRANT_TTL_MS } from './vault.ts'
import { createApp } from './app.ts'
import { clientIp } from './http.ts'
import { DEFAULT_LIMITS, loadConfig, type ServerConfig } from './config.ts'
import type { WebAuthn } from './authRoutes.ts'
import { BACKENDS, type TestBackend, type TestDatabase } from './testDatabases.ts'
import { acknowledgmentMessage, type AcknowledgmentFields } from '@msa/core/acknowledgment'

const dirs: string[] = []
const servers: Server[] = []
let current: TestBackend = BACKENDS[0]!

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

const database = () => current.open()

let counter = 0

const fakeWebAuthn = (): WebAuthn & { lastChallenge: string } => {
  const fake = {
    lastChallenge: '',
    generateRegistrationOptions: async () => {
      fake.lastChallenge = `challenge-${++counter}`
      return { challenge: fake.lastChallenge } as never
    },
    generateAuthenticationOptions: async () => {
      fake.lastChallenge = `challenge-${++counter}`
      return { challenge: fake.lastChallenge } as never
    },
    verifyRegistrationResponse: async (options: { response: { id: string; challenge: string }; expectedChallenge: unknown }) => {
      const ok = await (options.expectedChallenge as (challenge: string) => boolean)(options.response.challenge)
      if (!ok) throw new Error('Unexpected challenge')
      return {
        verified: true,
        registrationInfo: { credential: { id: options.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } },
      } as never
    },
    verifyAuthenticationResponse: async (options: { response: { challenge: string }; expectedChallenge: unknown; credential: { counter: number } }) => {
      const ok = await (options.expectedChallenge as (challenge: string) => boolean)(options.response.challenge)
      if (!ok) throw new Error('Unexpected challenge')
      return { verified: true, authenticationInfo: { newCounter: options.credential.counter + 1 } } as never
    },
  }
  return fake as never
}

interface Reply {
  status: number
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

const start = async (db: TestDatabase, now?: () => number, overrides: Partial<ServerConfig> = {}) => {
  const webauthn = fakeWebAuthn()
  let app: ReturnType<typeof createApp> | null = null
  const server = createServer((req, res) => void app!(req, res))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  const config: ServerConfig = { ...loadConfig({ PORT_API: String(port) }), ...overrides }
  const host = config.mode === 'hosted' && config.hosts[0] ? config.hosts[0] : `localhost:${port}`
  const origin = config.mode === 'hosted' && config.hosts[0] ? `https://${config.hosts[0]}` : `http://localhost:${port}`
  app = createApp({ database: db.database, config, staticDir: join(tmpdir(), 'missing-static'), webauthn, now })
  let cookie = ''
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            Host: host,
            Origin: origin,
            ...(method === 'GET' ? {} : { 'X-MSA': '1' }),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const setCookie = res.headers['set-cookie']?.[0]
            if (setCookie) cookie = setCookie.split(';')[0]!.endsWith('=') ? '' : setCookie.split(';')[0]!
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null, headers: res.headers })
          })
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
  const setupCode = () => db.database.auth({ now }).createSetupCode()
  const register = async (name: string, credentialId: string, given?: string) => {
    const code = given ?? (config.mode === 'self' ? await setupCode() : undefined)
    await call('POST', '/api/auth/register/options', { accountName: name, setupCode: code })
    return call('POST', '/api/auth/register/verify', { setupCode: code, response: { id: credentialId, challenge: webauthn.lastChallenge } })
  }
  const login = async (credentialId: string) => {
    await call('POST', '/api/auth/login/options', {})
    return call('POST', '/api/auth/login/verify', { response: { id: credentialId, challenge: webauthn.lastChallenge } })
  }
  return { call, register, login, webauthn, port, setupCode, setCookie: (value: string) => (cookie = value), cookie: () => cookie }
}


describe.each(BACKENDS)('$name', { timeout: 60_000 }, (backend) => {
  beforeEach(() => {
    current = backend
  })

  afterEach(() => backend.cleanup())

  describe('sessions', () => {
    it('stores only a hash of the token and expires after 30 days', async () => {
      const db = await database()
      let time = 1_000_000
      const auth = db.database.auth({ now: () => time })
      await auth.registerAccount('Me', { id: 'cred', publicKey: new Uint8Array([1]), counter: 0, transports: [], rpId: 'localhost', name: 'Mac' })
      const accountId = (await auth.accounts())[0]!.id
      const token = await auth.createSession(accountId, 'test')
      const rows = (await db.all('sessions')).map((row) => ({ token_hash: row.token_hash }))
      expect(rows).toEqual([{ token_hash: hashToken(token) }])
      expect(JSON.stringify(rows)).not.toContain(token)
      expect((await auth.validateSession(token))?.session.accountId).toBe(accountId)
      expect(await auth.validateSession('x'.repeat(43))).toBeNull()
      time += SESSION_TTL_MS + 1
      expect(await auth.validateSession(token)).toBeNull()
      expect(await db.count('sessions')).toBe(0)
    })

    it('slides the expiry when the session is used', async () => {
      const db = await database()
      let time = 1_000_000
      const auth = db.database.auth({ now: () => time })
      await auth.registerAccount('Me', { id: 'cred', publicKey: new Uint8Array([1]), counter: 0, transports: [], rpId: 'localhost', name: 'Mac' })
      const token = await auth.createSession((await auth.accounts())[0]!.id, 'test')
      time += SESSION_TTL_MS - 1000
      expect((await auth.validateSession(token))?.refreshed).toBe(true)
      time += SESSION_TTL_MS - 1000
      expect(await auth.validateSession(token)).not.toBeNull()
    })

    it('keeps only the most recent sessions per account', async () => {
      const db = await database()
      let time = 1_000_000
      const auth = db.database.auth({ now: () => time, limits: { passkeysPerAccount: 10, sessionsPerAccount: 3 } })
      await auth.registerAccount('Me', { id: 'cred', publicKey: new Uint8Array([1]), counter: 0, transports: [], rpId: 'localhost', name: 'Mac' })
      const accountId = (await auth.accounts())[0]!.id
      const tokens: string[] = []
      for (let index = 0; index < 5; index++) {
        time += 1000
        tokens.push(await auth.createSession(accountId, 'test'))
      }
      expect(await auth.validateSession(tokens[0]!)).toBeNull()
      expect(await auth.validateSession(tokens[1]!)).toBeNull()
      expect(await auth.validateSession(tokens[4]!)).not.toBeNull()
    })
  })

  describe('challenges', () => {
    it('can be used once, only for their purpose and host, and expire', async () => {
      const db = await database()
      let time = 0
      const auth = db.database.auth({ now: () => time })
      await auth.saveChallenge({ challenge: 'a', purpose: 'login', rpId: 'localhost', accountId: null, accountName: null })
      expect(await auth.consumeChallenge('a', 'register', 'localhost')).toBeNull()
      await auth.saveChallenge({ challenge: 'b', purpose: 'login', rpId: 'localhost', accountId: null, accountName: null })
      expect(await auth.consumeChallenge('b', 'login', 'other.host')).toBeNull()
      await auth.saveChallenge({ challenge: 'c', purpose: 'login', rpId: 'localhost', accountId: null, accountName: null })
      expect(await auth.consumeChallenge('c', 'login', 'localhost')).not.toBeNull()
      expect(await auth.consumeChallenge('c', 'login', 'localhost')).toBeNull()
      await auth.saveChallenge({ challenge: 'd', purpose: 'login', rpId: 'localhost', accountId: null, accountName: null })
      time += CHALLENGE_TTL_MS + 1
      expect(await auth.consumeChallenge('d', 'login', 'localhost')).toBeNull()
    })
  })

  describe('auth over http', () => {
    it('requires a session for data and sets a strict http-only cookie', async () => {
      const app = await start(await database())
      expect((await app.call('GET', '/api/chains')).status).toBe(401)
      const registered = await app.register('Paul', 'cred-1')
      expect(registered.status).toBe(200)
      const cookie = String(registered.headers['set-cookie'])
      expect(cookie).toMatch(/^lokhus_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/)
      expect((await app.call('GET', '/api/chains')).status).toBe(200)
      const status = await app.call('GET', '/api/auth/status')
      expect(status.body).toMatchObject({ signedIn: true, registrationOpen: false, account: { name: 'Paul' } })
    })

    it('marks the cookie secure behind an https proxy only when the proxy is trusted', async () => {
      const untrusted = await start(await database())
      const plainCode = await untrusted.setupCode()
      await untrusted.call('POST', '/api/auth/register/options', { accountName: 'Paul', setupCode: plainCode }, { 'X-Forwarded-Proto': 'https' })
      const plain = await untrusted.call(
        'POST',
        '/api/auth/register/verify',
        { setupCode: plainCode, response: { id: 'cred-1', challenge: untrusted.webauthn.lastChallenge } },
        { 'X-Forwarded-Proto': 'https' },
      )
      expect(String(plain.headers['set-cookie'])).not.toMatch(/Secure/)
      expect(plain.headers['strict-transport-security']).toBeUndefined()

      const app = await start(await database(), undefined, { trustProxy: true })
      const setupCode = await app.setupCode()
      await app.call('POST', '/api/auth/register/options', { accountName: 'Paul', setupCode }, { 'X-Forwarded-Proto': 'https' })
      const verified = await app.call(
        'POST',
        '/api/auth/register/verify',
        { setupCode, response: { id: 'cred-1', challenge: app.webauthn.lastChallenge } },
        { 'X-Forwarded-Proto': 'https' },
      )
      expect(String(verified.headers['set-cookie'])).toMatch(/; Secure$/)
      expect(verified.headers['strict-transport-security']).toMatch(/max-age=\d+/)
    })

    it('answers /healthz for any host without data, and only on that exact path', async () => {
      const app = await start(await database(), undefined, { mode: 'hosted', hosts: ['lokhus.test'], allowLocalhost: false })
      const health = await app.call('GET', '/healthz', undefined, { Host: 'container:8787', Origin: '' })
      expect(health.status).toBe(200)
      expect(health.body).toEqual({ ok: true })
      expect(health.headers['content-security-policy']).toMatch(/default-src 'self'/)
      expect((await app.call('GET', '/healthz?x=1', undefined, { Host: 'container:8787' })).status).toBe(403)
      expect((await app.call('GET', '/healthz/../api/safes', undefined, { Host: 'container:8787' })).status).toBe(403)
      expect((await app.call('POST', '/healthz', {}, { Host: 'container:8787' })).status).toBe(403)
    })

    it('reports 503 on /healthz when the database is down', async () => {
      const db = await database()
      const app = await start({ ...db, database: { ...db.database, ping: () => Promise.reject(new Error('down')) } })
      const health = await app.call('GET', '/healthz')
      expect(health.status).toBe(503)
      expect(health.body).toEqual({ ok: false })
    })

    it('closes registration after the first account', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      app.setCookie('')
      const second = await app.call('POST', '/api/auth/register/options', { accountName: 'Mallory', setupCode: await app.setupCode() })
      expect(second.status).toBe(403)
    })

    it('signs in with a registered passkey and rejects unknown ones', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      await app.call('POST', '/api/auth/logout', {})
      expect((await app.call('GET', '/api/chains')).status).toBe(401)
      expect((await app.login('nope')).status).toBe(401)
      expect((await app.login('cred-1')).status).toBe(200)
      expect((await app.call('GET', '/api/chains')).status).toBe(200)
    })

    it('refuses a replayed challenge', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      await app.call('POST', '/api/auth/logout', {})
      await app.call('POST', '/api/auth/login/options', {})
      const challenge = app.webauthn.lastChallenge
      expect((await app.call('POST', '/api/auth/login/verify', { response: { id: 'cred-1', challenge } })).status).toBe(200)
      await app.call('POST', '/api/auth/logout', {})
      expect((await app.call('POST', '/api/auth/login/verify', { response: { id: 'cred-1', challenge } })).status).toBe(401)
    })

    it('refuses to remove the last passkey', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      const removed = await app.call('DELETE', '/api/auth/passkeys/cred-1')
      expect(removed.status).toBe(409)
      await app.call('POST', '/api/auth/passkeys/options', {})
      await app.call('POST', '/api/auth/passkeys/verify', { response: { id: 'cred-2', challenge: app.webauthn.lastChallenge } })
      expect((await app.call('GET', '/api/auth/passkeys')).body).toHaveLength(2)
      expect((await app.call('DELETE', '/api/auth/passkeys/cred-1')).status).toBe(204)
    })

    it('only accepts passkeys from allowed origins', async () => {
      const app = await start(await database())
      const setupCode = await app.setupCode()
      for (const origin of ['http://127.0.0.1:8787', 'https://evil.example', 'http://localhost.evil.example', 'null']) {
        const reply = await app.call('POST', '/api/auth/register/options', { accountName: 'Paul', setupCode }, { Origin: origin })
        expect(reply.status, origin).toBe(403)
      }
      expect(
        (await app.call('POST', '/api/auth/register/options', { accountName: 'Paul', setupCode }, { Origin: 'http://localhost:5173' })).status,
      ).toBe(200)
    })

    it('redirects pages on 127.0.0.1 to localhost', async () => {
      const app = await start(await database())
      const reply = await app.call('GET', '/safes/x?tab=1', undefined, { Host: `127.0.0.1:${app.port}` })
      expect(reply.status).toBe(302)
      expect(reply.headers.location).toBe(`http://localhost:${app.port}/safes/x?tab=1`)
    })

    it('still rejects foreign hosts, cross-site requests and writes without X-MSA', async () => {
      const app = await start(await database())
      expect((await app.call('GET', '/api/auth/status', undefined, { Host: 'evil.example' })).status).toBe(403)
      expect((await app.call('GET', '/api/auth/status', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
      expect((await app.call('POST', '/api/auth/logout', {}, { 'X-MSA': '0' })).status).toBe(403)
    })

    it('moves existing local data into the first account and keeps accounts apart', async () => {
      const db = await database()
      await db.database.docStore('local').put('notes', { id: 'n1', entityType: 'general', entityId: 'n1', body: 'hi' } as never)
      await db.database.docStore('someone-else').put('notes', { id: 'n2', entityType: 'general', entityId: 'n2', body: 'secret' } as never)
      const app = await start(db)
      await app.register('Paul', 'cred-1')
      const notes = (await app.call('GET', '/api/notes')).body as { id: string }[]
      expect(notes.map((note) => note.id)).toEqual(['n1'])
      expect((await app.call('GET', '/api/notes/n2')).status).toBe(404)
    })

    it('lets an existing account register a new passkey after a reset', async () => {
      const db = await database()
      const app = await start(db)
      await app.register('Paul', 'cred-1')
      await app.call('PUT', '/api/notes/n1', { id: 'n1', entityType: 'general', entityId: 'n1', body: 'kept' })
      const { setupCode } = await db.database.auth().resetLogins()
      expect((await app.call('GET', '/api/notes')).status).toBe(401)
      const status = await app.call('GET', '/api/auth/status')
      expect(status.body).toMatchObject({ awaitingPasskey: true, registrationOpen: true, accountExists: true })
      expect((await app.register('Ignored', 'cred-2', 'WRONGCODE2')).status).toBe(403)
      expect((await app.register('Ignored', 'cred-2', setupCode)).status).toBe(200)
      expect((await app.call('GET', '/api/auth/status')).body).toMatchObject({ account: { name: 'Paul' } })
      expect(((await app.call('GET', '/api/notes')).body as unknown[]).length).toBe(1)
    })

    it('needs the setup code to register, and it works once', async () => {
      const app = await start(await database())
      const code = await app.setupCode()
      expect((await app.call('POST', '/api/auth/register/options', { accountName: 'Paul' })).status).toBe(403)
      expect((await app.call('POST', '/api/auth/register/options', { accountName: 'Paul', setupCode: 'AAAAAAAAAA' })).status).toBe(403)
      expect((await app.call('POST', '/api/auth/register/verify', { response: { id: 'x', challenge: 'y' } })).status).toBe(403)
      expect((await app.register('Paul', 'cred-1', code.toLowerCase())).status).toBe(200)
      app.setCookie('')
      expect((await app.call('POST', '/api/auth/register/options', { accountName: 'Mallory', setupCode: code })).status).toBe(403)
    })

    it('locks the setup code for a minute after five wrong tries', async () => {
      const db = await database()
      let time = 1_000_000
      const app = await start(db, () => time)
      const code = await app.setupCode()
      const attempt = (setupCode: string) => app.call('POST', '/api/auth/register/options', { accountName: 'Paul', setupCode })
      for (let tries = 0; tries < 4; tries++) expect((await attempt('WRONGWRONG')).status).toBe(403)
      expect((await attempt('WRONGWRONG')).status).toBe(429)
      expect((await attempt(code)).status).toBe(429)
      time += SETUP_LOCK_MS + 1
      expect((await attempt(code)).status).toBe(200)
    })

    it('stores only a hash of the setup code', async () => {
      const db = await database()
      const code = await db.database.auth().createSetupCode()
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
      expect(JSON.stringify(await db.all('setup_code'))).not.toContain(code)
    })

    it('signs out everywhere', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      const first = app.cookie()
      await app.login('cred-1')
      await app.call('POST', '/api/auth/logout-all', {})
      app.setCookie(first)
      expect((await app.call('GET', '/api/chains')).status).toBe(401)
    })
  })

  const hosted = (overrides: Partial<ServerConfig> = {}): Partial<ServerConfig> => ({
    mode: 'hosted',
    hosts: ['lokhus.example'],
    allowLocalhost: false,
    trustProxy: true,
    ...overrides,
  })

  describe('hosted mode', () => {
    it('lets anyone create an account without a setup code, each starting empty', async () => {
      const db = await database()
      await db.database.docStore('local').put('notes', { id: 'legacy', entityType: 'general', entityId: 'legacy', body: 'old' } as never)
      const first = await start(db, undefined, hosted())
      const status = await first.call('GET', '/api/auth/status')
      expect(status.body).toMatchObject({ mode: 'hosted', registrationOpen: true, needsSetupCode: false, accountExists: false })
      expect((await first.register('Alice', 'alice-1')).status).toBe(200)
      expect((await first.call('GET', '/api/notes')).body).toEqual([])
      await first.call('PUT', '/api/notes/a', { id: 'a', entityType: 'general', entityId: 'a', body: 'alice' })
      first.setCookie('')
      expect((await first.register('Bob', 'bob-1')).status).toBe(200)
      expect((await first.call('GET', '/api/notes')).body).toEqual([])
      expect((await first.call('GET', '/api/notes/a')).status).toBe(404)
      expect(await db.count('docs', { account: 'local' })).toBe(1)
    })

    it('refuses localhost and plain http unless the dev flag is set', async () => {
      const app = await start(await database(), undefined, hosted())
      expect((await app.call('GET', '/api/auth/status', undefined, { Host: `localhost:${app.port}` })).status).toBe(403)
      expect((await app.call('GET', '/api/auth/status', undefined, { Host: `127.0.0.1:${app.port}` })).status).toBe(403)
      const http = await app.call('POST', '/api/auth/register/options', { accountName: 'Eve' }, { Origin: 'http://lokhus.example' })
      expect(http.status).toBe(403)
      const local = await app.call('POST', '/api/auth/register/options', { accountName: 'Eve' }, { Origin: 'http://localhost:5173' })
      expect(local.status).toBe(403)
    })

    it('rate limits sign-up per client ip and answers 429 with Retry-After', async () => {
      const app = await start(await database(), undefined, hosted({ limits: { ...DEFAULT_LIMITS, registerPerHour: 2 } }))
      const attempt = (ip: string) => app.call('POST', '/api/auth/register/options', { accountName: 'Spam' }, { 'X-Forwarded-For': `9.9.9.9, ${ip}` })
      expect((await attempt('1.1.1.1')).status).toBe(200)
      expect((await attempt('1.1.1.1')).status).toBe(200)
      const limited = await attempt('1.1.1.1')
      expect(limited.status).toBe(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
      expect((await attempt('2.2.2.2')).status).toBe(200)
    })
  })

  describe('client ip and proxies', () => {
    it('ignores spoofed X-Forwarded-For unless the proxy is trusted', async () => {
      const limits = { ...DEFAULT_LIMITS, authPerMinute: 2 }
      const direct = await start(await database(), undefined, { limits })
      const spoofed = (n: number) => direct.call('POST', '/api/auth/login/options', {}, { 'X-Forwarded-For': `10.0.0.${n}` })
      expect((await spoofed(1)).status).toBe(200)
      expect((await spoofed(2)).status).toBe(200)
      expect((await spoofed(3)).status).toBe(429)

      const proxied = await start(await database(), undefined, { limits, trustProxy: true })
      const forwarded = (n: number) => proxied.call('POST', '/api/auth/login/options', {}, { 'X-Forwarded-For': `10.0.0.${n}` })
      expect((await forwarded(1)).status).toBe(200)
      expect((await forwarded(1)).status).toBe(200)
      expect((await forwarded(2)).status).toBe(200)
    })
  })

  describe('limits on data', () => {
    it('rejects oversized bodies, full collections and write floods', async () => {
      const limits = { ...DEFAULT_LIMITS, docBodyBytes: 2_000, docsPerCollection: 2, writesPerMinute: 4 }
      const app = await start(await database(), undefined, { limits })
      await app.register('Paul', 'cred-1')
      const big = await app.call('PUT', '/api/notes/big', { id: 'big', entityType: 'general', entityId: 'big', body: 'x'.repeat(5_000) })
      expect(big.status).toBe(413)
      expect((await app.call('PUT', '/api/notes/a', { id: 'a', entityType: 'general', entityId: 'a', body: '' })).status).toBe(200)
      expect((await app.call('PUT', '/api/notes/b', { id: 'b', entityType: 'general', entityId: 'b', body: '' })).status).toBe(200)
      const full = await app.call('PUT', '/api/notes/c', { id: 'c', entityType: 'general', entityId: 'c', body: '' })
      expect(full.status).toBe(507)
      expect((full.body as { error: string }).error).toMatch(/limit of 2 notes/)
      const flood = await app.call('PUT', '/api/notes/a', { id: 'a', entityType: 'general', entityId: 'a', body: 'again' })
      expect(flood.status).toBe(429)
    })

    it('caps passkeys per account', async () => {
      const app = await start(await database(), undefined, { limits: { ...DEFAULT_LIMITS, passkeysPerAccount: 2 } })
      await app.register('Paul', 'cred-1')
      await app.call('POST', '/api/auth/passkeys/options', {})
      await app.call('POST', '/api/auth/passkeys/verify', { response: { id: 'cred-2', challenge: app.webauthn.lastChallenge } })
      expect((await app.call('POST', '/api/auth/passkeys/options', {})).status).toBe(409)
    })
  })

  describe('security headers', () => {
    it('are sent on every response, with HSTS only over https', async () => {
      const app = await start(await database())
      for (const reply of [await app.call('GET', '/api/auth/status'), await app.call('GET', '/api/nope'), await app.call('GET', '/api/chains')]) {
        expect(reply.headers['content-security-policy']).toMatch(/default-src 'self'/)
        expect(reply.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/)
        expect(reply.headers['x-content-type-options']).toBe('nosniff')
        expect(reply.headers['referrer-policy']).toBe('no-referrer')
        expect(reply.headers['cross-origin-opener-policy']).toBe('same-origin')
        expect(reply.headers['permissions-policy']).toMatch(/usb=\(self\)/)
        expect(reply.headers['strict-transport-security']).toBeUndefined()
      }
      expect((await app.call('GET', '/api/auth/status', undefined, { Host: 'evil.example' })).headers['content-security-policy']).toBeTruthy()
    })

    it('only allows local RPCs in the CSP when localhost is allowed', () => {
      expect(securityHeaders({ allowLocalhost: true }, false)['Content-Security-Policy']).toMatch(/http:\/\/localhost:\*/)
      expect(securityHeaders({ allowLocalhost: false }, true)['Content-Security-Policy']).not.toMatch(/http:/)
      expect(securityHeaders({ allowLocalhost: false }, true)['Strict-Transport-Security']).toMatch(/max-age/)
    })
  })


  describe('encryption keys and recovery', () => {
    const secret = (fill: string) => fill.repeat(64)
    const wrapped = 'w'.repeat(40)

    it('stores locked keys only for the account own passkeys and needs a fresh passkey to replace one', async () => {
      let time = 1_000_000
      const app = await start(await database(), () => time)
      await app.register('Paul', 'cred-1')
      expect((await app.call('PUT', '/api/auth/keys/passkey/cred-1', { kind: 'prf', wrapped })).status).toBe(200)
      expect((await app.call('PUT', '/api/auth/keys/passkey/nope', { kind: 'prf', wrapped })).status).toBe(404)
      expect((await app.call('PUT', '/api/auth/keys/passkey/cred-1', { kind: 'recovery', wrapped })).status).toBe(400)
      time += 6 * 60 * 1000
      const replace = await app.call('PUT', '/api/auth/keys/passkey/cred-1', { kind: 'prf', wrapped: 'x'.repeat(40) })
      expect(replace.status).toBe(403)
      expect(replace.body).toMatchObject({ code: 'step_up' })
      await app.call('POST', '/api/auth/stepup/options', {})
      expect((await app.call('POST', '/api/auth/stepup/verify', { response: { id: 'cred-1', challenge: app.webauthn.lastChallenge } })).status).toBe(200)
      expect((await app.call('PUT', '/api/auth/keys/passkey/cred-1', { kind: 'prf', wrapped: 'x'.repeat(40) })).status).toBe(200)
      expect((await app.call('GET', '/api/auth/keys/passkey/cred-1')).body).toMatchObject({ kind: 'prf', wrapped: 'x'.repeat(40) })
    })

    it('sets the key check once', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      expect((await app.call('PUT', '/api/auth/keys/check', { check: 'a'.repeat(43) })).body).toEqual({ check: 'a'.repeat(43) })
      expect((await app.call('PUT', '/api/auth/keys/check', { check: 'b'.repeat(43) })).body).toEqual({ check: 'a'.repeat(43) })
    })

    it('refuses plaintext docs once the account has a key', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      expect((await app.call('PUT', '/api/owners/a', { id: 'a', label: 'Ledger' })).status).toBe(200)
      await app.call('PUT', '/api/auth/keys/check', { check: 'a'.repeat(43) })
      expect((await app.call('PUT', '/api/owners/b', { id: 'b', label: 'Ledger' })).status).toBe(400)
      expect((await app.call('PUT', '/api/owners/c', { id: 'c', v: 1, enc: 'sealed' })).status).toBe(200)
    })

    it('needs a fresh step-up to set even the first recovery code', async () => {
      let time = 5_000_000
      const app = await start(await database(), () => time)
      await app.register('Paul', 'cred-1')
      time += 6 * 60 * 1000
      const first = await app.call('PUT', '/api/auth/recovery/code', { authSecret: secret('a'), wrapped, salt: null })
      expect(first.status).toBe(403)
      expect(first.body).toMatchObject({ code: 'step_up' })
    })

    it('recovers access with the recovery code once, and a new code replaces the old', async () => {
      const app = await start(await database())
      await app.register('Paul', 'cred-1')
      expect((await app.call('PUT', '/api/auth/recovery/code', { authSecret: secret('a'), wrapped, salt: null })).status).toBe(200)
      expect((await app.call('PUT', '/api/auth/recovery/code', { authSecret: secret('b'), wrapped, salt: null })).status).toBe(200)
      await app.call('POST', '/api/auth/logout', {})
      expect((await app.call('POST', '/api/auth/recover/code', { authSecret: secret('a') })).status).toBe(401)
      const found = await app.call('POST', '/api/auth/recover/code', { authSecret: secret('b') })
      expect(found.status).toBe(200)
      const { grant } = found.body as { grant: string }
      expect(found.body).toMatchObject({ account: { name: 'Paul' }, locked: { kind: 'recovery', wrapped } })
      expect((await app.call('GET', '/api/chains')).status).toBe(401)
      await app.call('POST', '/api/auth/recover/passkey/options', { grant })
      const added = await app.call('POST', '/api/auth/recover/passkey/verify', { grant, response: { id: 'cred-2', challenge: app.webauthn.lastChallenge } })
      expect(added.status).toBe(200)
      expect((await app.call('GET', '/api/chains')).status).toBe(200)
      app.setCookie('')
      expect((await app.call('POST', '/api/auth/recover/passkey/options', { grant })).status).toBe(401)
    })

    it('recovers access only when enough distinct recovery wallets sign a fresh challenge', async () => {
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
      let time = 5_000_000
      const app = await start(await database(), () => time)
      await app.register('Paul', 'cred-1')
      const wallets = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))
      const stranger = privateKeyToAccount(generatePrivateKey())
      expect(
        (await app.call('PUT', '/api/auth/recovery/wallets', { addresses: wallets.map((wallet) => wallet.address), threshold: 4 })).status,
      ).toBe(400)
      expect(
        (await app.call('PUT', '/api/auth/recovery/wallets', { addresses: wallets.map((wallet) => wallet.address), threshold: 2 })).status,
      ).toBe(200)
      await app.call('POST', '/api/auth/logout', {})
      const attempt = async (signers: typeof wallets) => {
        const { challenge, message } = (await app.call('POST', '/api/auth/recover/wallets/options', {})).body as { challenge: string; message: string }
        const signatures = await Promise.all(signers.map((signer) => signer.signMessage({ message })))
        return app.call('POST', '/api/auth/recover/wallets/verify', { challenge, signatures })
      }
      expect((await attempt([wallets[0]!])).status).toBe(401)
      expect((await attempt([wallets[0]!, wallets[0]!])).status).toBe(401)
      expect((await attempt([wallets[0]!, stranger])).status).toBe(401)
      expect((await attempt([wallets[0]!, wallets[2]!])).status).toBe(200)
      const { challenge, message } = (await app.call('POST', '/api/auth/recover/wallets/options', {})).body as { challenge: string; message: string }
      const signatures = await Promise.all([wallets[0]!, wallets[1]!].map((signer) => signer.signMessage({ message })))
      time += CHALLENGE_TTL_MS + 1
      expect((await app.call('POST', '/api/auth/recover/wallets/verify', { challenge, signatures })).status).toBe(401)
    })

    it('exports only after a fresh passkey and leaves out recovery hashes', async () => {
      let time = 1_000_000
      const app = await start(await database(), () => time)
      await app.register('Paul', 'cred-1')
      await app.call('PUT', '/api/chains/137', { id: '137', enc: 'ciphertext', v: 1 })
      await app.call('PUT', '/api/auth/recovery/code', { authSecret: secret('c'), wrapped, salt: null })
      const exported = await app.call('GET', '/api/auth/export')
      expect(exported.status).toBe(200)
      expect(JSON.stringify(exported.body)).not.toMatch(/auth_hash|authHash/)
      expect(exported.body).toMatchObject({ format: 'lokhus-backup-1', docs: [{ collection: 'chains', id: '137', data: { enc: 'ciphertext' } }] })
      time += 6 * 60 * 1000
      expect((await app.call('GET', '/api/auth/export')).status).toBe(403)
    })

    it('bulk-deletes only the account plaintext docs of one collection', async () => {
      const db = await database()
      const app = await start(db)
      await app.register('Paul', 'cred-1')
      await app.call('PUT', '/api/activity/plain-1', { id: 'plain-1', safeId: 's1', blockNumber: '1' })
      await app.call('PUT', '/api/activity/plain-2', { id: 'plain-2', safeId: 's1', blockNumber: '2' })
      await app.call('PUT', '/api/activity/hidden-1', { id: 'hidden-1', v: 1, enc: 'ciphertext' })
      await app.call('PUT', '/api/notes/plain-note', { id: 'plain-note', body: 'keep' })
      await db.insertDoc('someone-else', 'activity', 'x', {})
      expect((await app.call('DELETE', '/api/activity')).status).toBe(405)
      const removed = await app.call('DELETE', '/api/activity?_plaintext=1')
      expect(removed.body).toEqual({ removed: 2 })
      expect(((await app.call('GET', '/api/activity')).body as { id: string }[]).map((doc) => doc.id)).toEqual(['hidden-1'])
      expect((await app.call('GET', '/api/notes/plain-note')).status).toBe(200)
      expect(await db.count('docs', { account: 'someone-else' })).toBe(1)
      expect((await app.call('DELETE', '/api/activity?_plaintext=1')).body).toEqual({ removed: 0 })
      app.setCookie('')
      expect((await app.call('DELETE', '/api/activity?_plaintext=1')).status).toBe(401)
    })

    it('stores a signed acknowledgment in readable form and refuses forged ones', async () => {
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
      const time = Date.parse('2026-11-14T12:00:00.000Z')
      const db = await database()
      const app = await start(db, () => time, hosted())
      const signer = privateKeyToAccount(generatePrivateKey())
      const stranger = privateKeyToAccount(generatePrivateKey())
      const fields: AcknowledgmentFields = {
        kind: 'stocks',
        signer: signer.address,
        safe: '0x' + 'A'.repeat(40),
        chainId: 146,
        blockNumber: '123456',
        date: new Date(time).toISOString(),
      }
      const message = acknowledgmentMessage(fields)
      const body = { ...fields, message, signature: await signer.signMessage({ message }) }
      expect((await app.call('GET', '/api/auth/acknowledgments/stocks')).status).toBe(401)
      await app.register('Paul', 'cred-1')
      expect((await app.call('GET', '/api/auth/acknowledgments/stocks')).body).toEqual({ kind: 'stocks', version: 1, required: true, acknowledgment: null })
      expect((await app.call('GET', '/api/auth/acknowledgments/other')).status).toBe(404)
      expect((await app.call('POST', '/api/acknowledgments', body)).status).toBe(404)
      const forged = { ...body, signature: await stranger.signMessage({ message }) }
      expect((await app.call('POST', '/api/auth/acknowledgments', forged)).status).toBe(400)
      const edited = { ...body, message: message.replace('no shareholder rights', 'shareholder rights') }
      expect((await app.call('POST', '/api/auth/acknowledgments', edited)).status).toBe(400)
      expect((await app.call('POST', '/api/auth/acknowledgments', { ...body, chainId: 137 })).status).toBe(400)
      const stale = { ...fields, date: new Date(time - 2 * 60 * 60 * 1000).toISOString() }
      const staleMessage = acknowledgmentMessage(stale)
      const staleBody = { ...stale, message: staleMessage, signature: await signer.signMessage({ message: staleMessage }) }
      expect((await app.call('POST', '/api/auth/acknowledgments', staleBody)).status).toBe(400)
      const saved = await app.call('POST', '/api/auth/acknowledgments', body)
      expect(saved.status).toBe(200)
      expect(saved.body).toMatchObject({ kind: 'stocks', version: 1, message, signer: signer.address.toLowerCase(), chainId: 146, blockNumber: '123456' })
      expect((await app.call('POST', '/api/auth/acknowledgments', body)).status).toBe(200)
      expect(await db.count('acknowledgments')).toBe(1)
      expect((await db.all('acknowledgments'))[0]!.message).toBe(message)
      expect(((await app.call('GET', '/api/auth/acknowledgments/stocks')).body as { acknowledgment: unknown }).acknowledgment).toMatchObject({ message })
      expect(((await app.call('GET', '/api/auth/export')).body as { acknowledgments: unknown[] }).acknowledgments).toHaveLength(1)
      expect((await app.call('GET', '/api/acknowledgments')).status).toBe(404)
      expect((await app.call('DELETE', '/api/auth/account', { confirmName: 'Paul' })).status).toBe(200)
      expect(await db.count('acknowledgments')).toBe(0)
    })

    it('does not ask for or store acknowledgments in self mode', async () => {
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
      const db = await database()
      const app = await start(db)
      await app.register('Paul', 'cred-1')
      const signer = privateKeyToAccount(generatePrivateKey())
      const fields: AcknowledgmentFields = {
        kind: 'stocks',
        signer: signer.address,
        safe: '0x' + 'A'.repeat(40),
        chainId: 146,
        blockNumber: '1',
        date: new Date().toISOString(),
      }
      const message = acknowledgmentMessage(fields)
      expect((await app.call('GET', '/api/auth/acknowledgments/stocks')).body).toEqual({ kind: 'stocks', version: 1, required: false, acknowledgment: null })
      expect((await app.call('POST', '/api/auth/acknowledgments', { ...fields, message, signature: await signer.signMessage({ message }) })).status).toBe(404)
      expect(await db.count('acknowledgments')).toBe(0)
    })

    it('deletes everything that belongs to an account', async () => {
      const db = await database()
      const app = await start(db)
      await app.register('Paul', 'cred-1')
      await app.call('PUT', '/api/chains/137', { id: '137', enc: 'ciphertext', v: 1 })
      await app.call('PUT', '/api/auth/keys/passkey/cred-1', { kind: 'prf', wrapped })
      await app.call('PUT', '/api/auth/recovery/code', { authSecret: secret('d'), wrapped, salt: null })
      await app.call('PUT', '/api/auth/recovery/wallets', { addresses: ['0x' + '1'.repeat(40)], threshold: 1 })
      expect((await app.call('DELETE', '/api/auth/account', { confirmName: 'paul' })).status).toBe(400)
      const deleted = await app.call('DELETE', '/api/auth/account', { confirmName: 'Paul' })
      expect(deleted.status).toBe(200)
      expect((await app.call('GET', '/api/chains')).status).toBe(401)
      for (const table of [
        'accounts',
        'passkeys',
        'sessions',
        'docs',
        'account_usage',
        'locked_keys',
        'account_keys',
        'recovery_codes',
        'recovery_wallets',
        'recovery_wallet_addresses',
        'recovery_grants',
        'acknowledgments',
      ])
        expect(await db.count(table), table).toBe(0)
    })
  })

  describe('recovery with a passkey that is already on the device', () => {
    const secret = 'e'.repeat(64)
    const wrapped = 'w'.repeat(40)

    const twoAccounts = async (now?: () => number) => {
      const app = await start(await database(), now, hosted())
      await app.register('Paul', 'cred-a')
      await app.call('PUT', '/api/auth/recovery/code', { authSecret: secret, wrapped, salt: null })
      app.setCookie('')
      await app.register('Mallory', 'cred-b')
      app.setCookie('')
      const grant = ((await app.call('POST', '/api/auth/recover/code', { authSecret: secret })).body as { grant: string }).grant
      return { app, grant }
    }

    const assertWith = async (app: Awaited<ReturnType<typeof start>>, grant: string, credentialId: string) => {
      await app.call('POST', '/api/auth/recover/passkey/assert/options', { grant })
      return app.call('POST', '/api/auth/recover/passkey/assert/verify', { grant, response: { id: credentialId, challenge: app.webauthn.lastChallenge } })
    }

    it('signs in with the account own passkey and uses up the grant', async () => {
      const { app, grant } = await twoAccounts()
      const done = await assertWith(app, grant, 'cred-a')
      expect(done.status).toBe(200)
      expect(done.body).toMatchObject({ account: { name: 'Paul' }, passkeyId: 'cred-a' })
      expect((await app.call('GET', '/api/auth/status')).body).toMatchObject({ signedIn: true, account: { name: 'Paul' } })
      expect((await app.call('PUT', '/api/auth/keys/passkey/cred-a', { kind: 'prf', wrapped })).status).toBe(200)
      app.setCookie('')
      expect((await app.call('POST', '/api/auth/recover/passkey/assert/options', { grant })).status).toBe(401)
      expect((await app.call('POST', '/api/auth/recover/passkey/options', { grant })).status).toBe(401)
    })

    it('refuses a passkey of another account and keeps the grant usable', async () => {
      const { app, grant } = await twoAccounts()
      expect((await assertWith(app, grant, 'cred-b')).status).toBe(401)
      expect((await assertWith(app, grant, 'unknown')).status).toBe(401)
      expect((await app.call('GET', '/api/chains')).status).toBe(401)
      expect((await assertWith(app, grant, 'cred-a')).status).toBe(200)
    })

    it('refuses an expired or missing grant', async () => {
      let time = 1_000_000
      const { app, grant } = await twoAccounts(() => time)
      await app.call('POST', '/api/auth/recover/passkey/assert/options', { grant })
      const challenge = app.webauthn.lastChallenge
      time += GRANT_TTL_MS + 1
      expect((await app.call('POST', '/api/auth/recover/passkey/assert/verify', { grant, response: { id: 'cred-a', challenge } })).status).toBe(401)
      expect((await app.call('POST', '/api/auth/recover/passkey/assert/options', { grant })).status).toBe(401)
      expect((await app.call('POST', '/api/auth/recover/passkey/assert/options', {})).status).toBe(401)
    })

    it('lets the register path use the grant only once either way', async () => {
      const { app, grant } = await twoAccounts()
      await app.call('POST', '/api/auth/recover/passkey/options', { grant })
      const registered = await app.call('POST', '/api/auth/recover/passkey/verify', { grant, response: { id: 'cred-new', challenge: app.webauthn.lastChallenge } })
      expect(registered.status).toBe(200)
      app.setCookie('')
      expect((await assertWith(app, grant, 'cred-a')).status).toBe(401)
    })
  })
})

describe('config', () => {
  it('defaults to self mode on 127.0.0.1 and requires hosts in hosted mode', () => {
    expect(loadConfig({})).toMatchObject({ mode: 'self', bind: '127.0.0.1', trustProxy: false, allowLocalhost: true })
    expect(() => loadConfig({ LOKHUS_MODE: 'hosted' })).toThrow(/LOKHUS_HOSTS/)
    expect(() => loadConfig({ LOKHUS_MODE: 'public' })).toThrow(/self or hosted/)
    expect(loadConfig({ LOKHUS_MODE: 'hosted', LOKHUS_HOSTS: 'lokhus.com, localhost' })).toMatchObject({
      hosts: ['lokhus.com'],
      allowLocalhost: false,
    })
    expect(loadConfig({ LOKHUS_MODE: 'hosted', LOKHUS_DEV_LOCALHOST: '1' }).allowLocalhost).toBe(true)
  })

  it('reads LOKHUS_PROXY_HOPS and picks that client address from the right', () => {
    expect(loadConfig({}).proxyHops).toBe(1)
    expect(loadConfig({ LOKHUS_PROXY_HOPS: '2' }).proxyHops).toBe(2)
    expect(() => loadConfig({ LOKHUS_PROXY_HOPS: '0' })).toThrow(/1 to 5/)
    expect(() => loadConfig({ LOKHUS_PROXY_HOPS: 'x' })).toThrow(/1 to 5/)
    const req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 173.245.48.1' }, socket: { remoteAddress: '10.0.0.2' } } as never
    expect(clientIp(req, true, 1)).toBe('173.245.48.1')
    expect(clientIp(req, true, 2)).toBe('1.2.3.4')
    expect(clientIp(req, false, 2)).toBe('10.0.0.2')
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.2' } } as never, true, 3)).toBe('10.0.0.2')
  })
})

describe('reset-login script', () => {
  it('refuses to run in hosted mode', async () => {
    const { spawnSync } = await import('node:child_process')
    const dir = mkdtempSync(join(tmpdir(), 'lokhus-reset-'))
    dirs.push(dir)
    const script = join(import.meta.dirname, '../../../scripts/reset-login.ts')
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, LOKHUS_MODE: 'hosted', MSA_DB: join(dir, 'app.db') },
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/only works in self-hosted mode/)
  })
})
