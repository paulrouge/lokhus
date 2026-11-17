import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import { openDatabaseFromEnv } from './database.ts'
import { ConfigError, loadConfig } from './config.ts'
import { loadGeoBlock, type GeoBlock } from './geo.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const DB_PATH = process.env.MSA_DB ?? join(ROOT, 'data/app.db')
const GEOIP_STALE_MS = 45 * 24 * 60 * 60 * 1000

let config
try {
  config = loadConfig(process.env)
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}

let geo: GeoBlock | undefined
if (config.blockedCountries.length > 0) {
  const file = config.geoipFile ?? join(ROOT, 'geoip/dbip-country-lite.csv.gz')
  try {
    geo = loadGeoBlock(file, config.blockedCountries)
  } catch (error) {
    console.error(`Cannot block ${config.blockedCountries.join(', ')}: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Run `make geoip` to download the country database, or set LOKHUS_BLOCKED_COUNTRIES=none.')
    process.exit(1)
  }
}

let database
try {
  database = await openDatabaseFromEnv(process.env, DB_PATH)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const auth = database.auth({ mode: config.mode, limits: config.limits })
const app = createApp({ database, config, auth, geo, staticDir: join(ROOT, 'packages/web/dist') })
const origin = config.mode === 'hosted' && config.hosts[0] ? `https://${config.hosts[0]}` : `http://localhost:${config.port}`

const server = createServer(app)

server.listen(config.port, config.bind, async () => {
  console.log(`Lokhus (${config.mode}) listening on ${config.bind}:${config.port}, open ${origin}`)
  console.log(`Storage: ${database.label}`)
  if (geo) {
    console.log(`Blocking visitors from ${geo.countries.join(', ')} (country data by DB-IP, from ${geo.updatedAt?.toISOString().slice(0, 10)})`)
    if (geo.updatedAt && Date.now() - geo.updatedAt.getTime() > GEOIP_STALE_MS) console.warn('The country database is over 45 days old. Rebuild or run `make geoip`.')
  }
  if (auth.needsSetupCode() && (await auth.registrationOpen())) {
    console.log(`Open ${origin}/signin?setup=${await auth.createSetupCode()} to create your passkey.`)
  }
})

let stopping = false
const stop = (signal: string) => {
  if (stopping) return
  stopping = true
  console.log(`${signal} received, shutting down`)
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  server.close(() => {
    void database.close().finally(() => process.exit(0))
  })
  server.closeIdleConnections()
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
