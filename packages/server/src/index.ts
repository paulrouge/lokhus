import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import { openDatabaseFromEnv } from './database.ts'
import { ConfigError, loadConfig } from './config.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const DB_PATH = process.env.MSA_DB ?? join(ROOT, 'data/app.db')

let config
try {
  config = loadConfig(process.env)
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}

let database
try {
  database = await openDatabaseFromEnv(process.env, DB_PATH)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const auth = database.auth({ mode: config.mode, limits: config.limits })
const app = createApp({ database, config, auth, staticDir: join(ROOT, 'packages/web/dist') })
const origin = config.mode === 'hosted' && config.hosts[0] ? `https://${config.hosts[0]}` : `http://localhost:${config.port}`

const server = createServer(app)

server.listen(config.port, config.bind, async () => {
  console.log(`Lokhus (${config.mode}) listening on ${config.bind}:${config.port}, open ${origin}`)
  console.log(`Storage: ${database.label}`)
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
