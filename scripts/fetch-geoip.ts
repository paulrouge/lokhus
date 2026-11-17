import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DEFAULT_BLOCKED_COUNTRIES } from '../packages/server/src/config.ts'
import { parseGeoCsv } from '../packages/server/src/geo.ts'

const target = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../geoip/dbip-country-lite.csv.gz'))

const monthsAgo = (count: number) => {
  const date = new Date()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - count)
  return date.toISOString().slice(0, 7)
}

const months = process.env.LOKHUS_GEOIP_MONTH ? [process.env.LOKHUS_GEOIP_MONTH] : [monthsAgo(0), monthsAgo(1)]

for (const month of months) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`LOKHUS_GEOIP_MONTH must look like 2026-11, got ${month}`)
  const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`
  const response = await fetch(url)
  if (!response.ok) {
    console.warn(`${url}: HTTP ${response.status}`)
    continue
  }
  const file = Buffer.from(await response.arrayBuffer())
  const ranges = parseGeoCsv(gunzipSync(file).toString('utf8'), DEFAULT_BLOCKED_COUNTRIES)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(`${target}.tmp`, file)
  renameSync(`${target}.tmp`, target)
  console.log(`DB-IP country lite ${month} saved to ${target} (${ranges.length} ranges for ${DEFAULT_BLOCKED_COUNTRIES.join(', ')})`)
  process.exit(0)
}
console.error('Could not download the DB-IP country database')
process.exit(1)
