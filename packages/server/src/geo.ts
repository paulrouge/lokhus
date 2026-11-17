import { readFileSync, statSync } from 'node:fs'
import { isIPv4, isIPv6 } from 'node:net'
import { gunzipSync } from 'node:zlib'

export interface GeoBlock {
  countries: string[]
  updatedAt: Date | null
  blockedCountry(ip: string): string | null
}

export const MIN_GEOIP_ROWS = 100_000

const V4_MAPPED = 0xffff_0000_0000n

const ipv4Number = (ip: string) => ip.split('.').reduce((total, part) => total * 256n + BigInt(part), 0n)

const ipv6Number = (ip: string) => {
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1]
  const text = embedded ? `${ip.slice(0, -embedded.length)}${(ipv4Number(embedded) >> 16n).toString(16)}:${(ipv4Number(embedded) & 0xffffn).toString(16)}` : ip
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return groups.reduce((total, group) => (total << 16n) + BigInt(`0x${group}`), 0n)
}

export const ipNumber = (ip: string): bigint | null => {
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0]!
  if (isIPv4(clean)) return V4_MAPPED + ipv4Number(clean)
  if (isIPv6(clean)) return ipv6Number(clean)
  return null
}

type Range = { from: bigint; to: bigint; country: string }

export const parseGeoCsv = (csv: string, countries: string[], minRows = MIN_GEOIP_ROWS): Range[] => {
  const wanted = new Set(countries)
  const ranges: Range[] = []
  let rows = 0
  for (const line of csv.split('\n')) {
    if (!line.trim()) continue
    rows++
    const [start = '', end = '', country = ''] = line.trim().split(',')
    if (!/^[A-Z]{2}$/.test(country)) throw new Error(`Unexpected GeoIP row: ${line.slice(0, 120)}`)
    if (!wanted.has(country)) continue
    const from = ipNumber(start)
    const to = ipNumber(end)
    if (from === null || to === null || to < from) throw new Error(`Unexpected GeoIP row: ${line.slice(0, 120)}`)
    ranges.push({ from, to, country })
  }
  if (rows < minRows) throw new Error(`The GeoIP file has only ${rows} rows`)
  const missing = countries.filter((code) => !ranges.some((range) => range.country === code))
  if (missing.length) throw new Error(`The GeoIP file has no addresses for ${missing.join(', ')}`)
  return ranges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

export const createGeoBlock = (ranges: Range[], countries: string[], updatedAt: Date | null = null): GeoBlock => ({
  countries,
  updatedAt,
  blockedCountry: (ip) => {
    const value = ipNumber(ip)
    if (value === null) return null
    let low = 0
    let high = ranges.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const range = ranges[middle]!
      if (value < range.from) high = middle - 1
      else if (value > range.to) low = middle + 1
      else return range.country
    }
    return null
  },
})

export const readGeoCsv = (file: string) => {
  const raw = readFileSync(file)
  return (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')
}

export const loadGeoBlock = (file: string, countries: string[]): GeoBlock =>
  createGeoBlock(parseGeoCsv(readGeoCsv(file), countries), countries, statSync(file).mtime)
