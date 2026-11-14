import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MANIFESTS = ['package.json', 'packages/core/package.json', 'packages/server/package.json', 'packages/web/package.json']
const REGISTRY = 'https://registry.npmjs.org/'
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'OFL-1.1',
  '(Apache-2.0 AND MIT)',
  'FSL-1.1-ALv2',
])
const REVIEWED_CUSTOM_LICENSES = [/^@reown\//, /^@walletconnect\//]

type LockEntry = { resolved?: string; integrity?: string; license?: string; dev?: boolean; link?: boolean }

const problems: string[] = []
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

const npmrc = readFileSync(join(ROOT, '.npmrc'), 'utf8')
for (const setting of ['ignore-scripts=true', 'save-exact=true']) {
  if (!npmrc.split('\n').some((line) => line.trim() === setting)) problems.push(`.npmrc must contain ${setting}`)
}

const workspaces = new Set(MANIFESTS.map((path) => readJson(path).name as string))
for (const path of MANIFESTS) {
  const manifest = readJson(path)
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries<string>(manifest[field] ?? {})) {
      if (workspaces.has(name)) continue
      if (!EXACT_VERSION.test(spec)) problems.push(`${path}: ${name}@${spec} is not pinned to an exact version`)
    }
  }
}

const lock = readJson('package-lock.json')
if (lock.lockfileVersion !== 3) problems.push(`package-lock.json lockfileVersion is ${lock.lockfileVersion}, expected 3`)

for (const [path, entry] of Object.entries<LockEntry>(lock.packages)) {
  if (!path.includes('node_modules/') || entry.link) continue
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
  if (!entry.resolved?.startsWith(REGISTRY)) problems.push(`${name} resolves outside the npm registry: ${entry.resolved}`)
  if (!entry.integrity?.startsWith('sha512-')) problems.push(`${name} has no sha512 integrity hash`)
  if (entry.dev) continue
  const reviewed = REVIEWED_CUSTOM_LICENSES.some((pattern) => pattern.test(name))
  if (!reviewed && !ALLOWED_LICENSES.has(entry.license ?? '')) problems.push(`${name} ships under an unreviewed licence: ${entry.license ?? 'none'}`)
}

if (problems.length) {
  console.error(`Supply chain check failed:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('Supply chain check passed.')
