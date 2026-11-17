export type Mode = 'self' | 'hosted'

export interface Limits {
  docBodyBytes: number
  authBodyBytes: number
  docsPerCollection: number
  activityDocs: number
  accountBytes: number
  passkeysPerAccount: number
  sessionsPerAccount: number
  authPerMinute: number
  registerPerHour: number
  recoverPerHour: number
  writesPerMinute: number
}

export interface ServerConfig {
  mode: Mode
  port: number
  bind: string
  hosts: string[]
  trustProxy: boolean
  proxyHops: number
  allowLocalhost: boolean
  blockedCountries: string[]
  geoipFile: string | null
  limits: Limits
}

export const DEFAULT_LIMITS: Limits = {
  docBodyBytes: 256 * 1024,
  authBodyBytes: 64 * 1024,
  docsPerCollection: 5_000,
  activityDocs: 200_000,
  accountBytes: 50 * 1024 * 1024,
  passkeysPerAccount: 10,
  sessionsPerAccount: 20,
  authPerMinute: 30,
  registerPerHour: 10,
  recoverPerHour: 20,
  writesPerMinute: 1_200,
}

export const DEFAULT_BLOCKED_COUNTRIES = ['US', 'CU', 'IR', 'KP', 'SY']

export class ConfigError extends Error {}

const parseCountries = (value: string | undefined, mode: Mode) => {
  const text = value?.trim().toUpperCase() ?? ''
  if (text === 'NONE') return []
  if (!text) return mode === 'hosted' ? DEFAULT_BLOCKED_COUNTRIES : []
  const countries = [...new Set(text.split(',').map((code) => code.trim()).filter(Boolean))]
  const invalid = countries.filter((code) => !/^[A-Z]{2}$/.test(code))
  if (invalid.length) throw new ConfigError(`LOKHUS_BLOCKED_COUNTRIES takes two-letter country codes or none, got ${invalid.join(', ')}`)
  return countries
}

export const parseHosts = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9.-]+$/.test(host) && host !== 'localhost')

const flag = (value: string | undefined) => value === '1' || value === 'true'

export const loadConfig = (env: Record<string, string | undefined>): ServerConfig => {
  const mode = env.LOKHUS_MODE ?? 'self'
  if (mode !== 'self' && mode !== 'hosted') throw new ConfigError(`LOKHUS_MODE must be self or hosted, got ${mode}`)
  const port = Number(env.PORT_API ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT_API is not a valid port: ${env.PORT_API}`)
  const proxyHops = Number(env.LOKHUS_PROXY_HOPS ?? 1)
  if (!Number.isInteger(proxyHops) || proxyHops < 1 || proxyHops > 5) throw new ConfigError(`LOKHUS_PROXY_HOPS must be 1 to 5, got ${env.LOKHUS_PROXY_HOPS}`)
  const hosts = parseHosts(env.LOKHUS_HOSTS)
  const allowLocalhost = mode === 'self' || flag(env.LOKHUS_DEV_LOCALHOST)
  if (mode === 'hosted' && hosts.length === 0 && !allowLocalhost)
    throw new ConfigError('Hosted mode needs LOKHUS_HOSTS (for example lokhus.com), or LOKHUS_DEV_LOCALHOST=1 for local testing')
  return {
    mode,
    port,
    bind: env.LOKHUS_BIND?.trim() || '127.0.0.1',
    hosts,
    trustProxy: flag(env.LOKHUS_TRUST_PROXY),
    proxyHops,
    allowLocalhost,
    blockedCountries: parseCountries(env.LOKHUS_BLOCKED_COUNTRIES, mode),
    geoipFile: env.LOKHUS_GEOIP_FILE?.trim() || null,
    limits: DEFAULT_LIMITS,
  }
}
