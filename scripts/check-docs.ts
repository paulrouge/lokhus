import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_LIMITS } from '../packages/server/src/config.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DOCS = ['README.md', 'CLAUDE.md', 'SECURITY.md', 'docs/postgres.md']
const ENV_VAR = /\b(?:LOKHUS_[A-Z_]+|MSA_[A-Z_]+|VITE_[A-Z_]+|PORT_API|APP_PORT|TEST_DATABASE_URL|DATABASE_URL)\b/g
const PATH_LIKE = /^(?:packages|scripts|docs|deploy|core|server|web)\/|\.(?:ts|tsx|md|css|json|yml|yaml|sh|html)$/

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
const docs = Object.fromEntries(DOCS.map((path) => [path, read(path)]))
const problems: string[] = []

const codeFiles = tracked.filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith('scripts/check-'))
const codeEnv = new Set(codeFiles.flatMap((path) => read(path).match(ENV_VAR) ?? []))
const makefile = read('Makefile')
const makeEnv = new Set(makefile.match(ENV_VAR) ?? [])

for (const name of codeEnv) {
  if (!docs['README.md'].includes(name)) problems.push(`README.md does not document ${name}, which the code reads`)
}
for (const [path, text] of Object.entries(docs)) {
  for (const name of new Set(text.match(ENV_VAR) ?? [])) {
    if (!codeEnv.has(name) && !makeEnv.has(name)) problems.push(`${path} mentions ${name}, which nothing reads`)
  }
}

const targets = new Set([...makefile.matchAll(/^([a-z][\w-]*):/gm)].map((match) => match[1]))
for (const [path, text] of Object.entries(docs)) {
  for (const [, target] of text.matchAll(/(?:^|`)make ([a-z][\w-]*)/gm)) {
    if (!targets.has(target)) problems.push(`${path} mentions make ${target}, which the Makefile does not define`)
  }
}

const exists = (ref: string) => tracked.some((file) => file === ref || file.endsWith(`/${ref}`) || file.startsWith(`${ref}/`) || file.includes(`/${ref}/`))
for (const [path, text] of Object.entries(docs)) {
  for (const [, ref] of text.matchAll(/`([^`\s]+)`/g)) {
    const clean = ref.replace(/[),.:/]+$/, '')
    if (!PATH_LIKE.test(clean) || /[*<>${}]|^https?:|^[/.]|\/dist\b/.test(clean)) continue
    if (!exists(clean)) problems.push(`${path} refers to ${clean}, which does not exist`)
  }
}

const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`)
const quotas = [
  `request size (${formatBytes(DEFAULT_LIMITS.docBodyBytes)})`,
  `${DEFAULT_LIMITS.activityDocs.toLocaleString('en-US')} activity items`,
  `${DEFAULT_LIMITS.docsPerCollection.toLocaleString('en-US')} of anything else`,
  `total storage (${formatBytes(DEFAULT_LIMITS.accountBytes)})`,
  `passkeys (${DEFAULT_LIMITS.passkeysPerAccount})`,
  `sessions (${DEFAULT_LIMITS.sessionsPerAccount})`,
]
for (const quota of quotas) {
  if (!docs['README.md'].includes(quota)) problems.push(`README.md quotas are out of date with DEFAULT_LIMITS: expected "${quota}"`)
}

if (problems.length) {
  console.error(`Docs check failed:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('Docs check passed.')
