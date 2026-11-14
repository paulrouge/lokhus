import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { loadConfig, type ServerConfig } from './config.ts'
import { SESSION_COOKIE } from './auth.ts'

const servers: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

const staticDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lokhus-static-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'prerendered'))
  writeFileSync(join(dir, 'index.html'), 'app shell')
  writeFileSync(join(dir, 'robots.txt'), 'hosted robots')
  writeFileSync(join(dir, 'prerendered', 'welcome.html'), 'welcome page')
  writeFileSync(join(dir, 'prerendered', 'trust.html'), 'trust page')
  return dir
}

const start = async (overrides: Partial<ServerConfig>) => {
  let app: ReturnType<typeof createApp> | null = null
  const server = createServer((req, res) => void app!(req, res))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  const config: ServerConfig = { ...loadConfig({ PORT_API: String(port) }), ...overrides }
  const host = config.hosts[0] ?? `localhost:${port}`
  const stub = {} as never
  app = createApp({ database: stub, config, staticDir: staticDir(), auth: stub, vault: stub, acknowledgments: stub, limiter: stub })
  return (path: string, cookie?: string) =>
    new Promise<{ body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    })
}

describe('static pages', () => {
  describe('hosted mode', () => {
    const hosted = { mode: 'hosted' as const, hosts: ['lokhus.test'], allowLocalhost: false }

    it('serves prerendered public pages to visitors without a session', async () => {
      const get = await start(hosted)
      const root = await get('/')
      expect(root.body).toBe('welcome page')
      expect(root.headers['x-robots-tag']).toBeUndefined()
      expect(root.headers.vary).toBe('Cookie')
      expect((await get('/trust')).body).toBe('trust page')
      expect((await get('/robots.txt')).body).toBe('hosted robots')
    })

    it('serves the app shell to signed-in visitors and keeps app routes out of search', async () => {
      const get = await start(hosted)
      expect((await get('/trust', `${SESSION_COOKIE}=abc`)).body).toBe('app shell')
      const app = await get('/safes/1')
      expect(app.body).toBe('app shell')
      expect(app.headers['x-robots-tag']).toBe('noindex')
    })
  })

  describe('self mode', () => {
    it('keeps everything out of search', async () => {
      const get = await start({})
      const welcome = await get('/welcome')
      expect(welcome.body).toBe('app shell')
      expect(welcome.headers['x-robots-tag']).toBe('noindex')
      expect((await get('/robots.txt')).body).toBe('User-agent: *\nDisallow: /\n')
    })
  })
})
