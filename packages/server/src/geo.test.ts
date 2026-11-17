import { describe, expect, it } from 'vitest'
import { createGeoBlock, ipNumber, parseGeoCsv } from './geo.ts'

const CSV = ['1.0.0.0,1.0.0.255,AU', '3.0.0.0,3.255.255.255,US', '5.160.0.0,5.160.255.255,IR', '2001::,2001:0:ffff:ffff:ffff:ffff:ffff:ffff,US', '2a01:4f8::,2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff,DE'].join('\n')

describe('geo', () => {
  it('parses IPv4, IPv6 and IPv4-mapped addresses into one number space', () => {
    expect(ipNumber('::ffff:3.1.2.3')).toBe(ipNumber('3.1.2.3'))
    expect(ipNumber('[2001::1]')).toBe(ipNumber('2001:0:0:0:0:0:0:1'))
    expect(ipNumber('fe80::1%en0')).toBe(ipNumber('fe80::1'))
    expect(ipNumber('::')).toBe(0n)
    expect(ipNumber('not an ip')).toBeNull()
    expect(ipNumber('1.2.3')).toBeNull()
  })

  it('finds the blocked country of an address and ignores the rest', () => {
    const geo = createGeoBlock(parseGeoCsv(CSV, ['US', 'IR'], 1), ['US', 'IR'])
    expect(geo.blockedCountry('3.4.5.6')).toBe('US')
    expect(geo.blockedCountry('::ffff:3.4.5.6')).toBe('US')
    expect(geo.blockedCountry('5.160.10.1')).toBe('IR')
    expect(geo.blockedCountry('2001:0:1::1')).toBe('US')
    expect(geo.blockedCountry('1.0.0.1')).toBeNull()
    expect(geo.blockedCountry('2a01:4f8::1')).toBeNull()
    expect(geo.blockedCountry('4.0.0.0')).toBeNull()
    expect(geo.blockedCountry('127.0.0.1')).toBeNull()
    expect(geo.blockedCountry('unknown')).toBeNull()
  })

  it('refuses a file that is truncated, malformed or missing a blocked country', () => {
    expect(() => parseGeoCsv(CSV, ['US'])).toThrow(/only 5 rows/)
    expect(() => parseGeoCsv(CSV, ['US', 'KP'], 1)).toThrow(/no addresses for KP/)
    expect(() => parseGeoCsv(`${CSV}\n<html>`, ['US'], 1)).toThrow(/Unexpected GeoIP row/)
    expect(() => parseGeoCsv(`${CSV}\n9.0.0.9,9.0.0.1,US`, ['US'], 1)).toThrow(/Unexpected GeoIP row/)
  })
})
