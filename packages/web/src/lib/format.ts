import { formatUnits } from 'viem'

const usdFormat = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

export const formatUsd = (value: number) => (value > 0 && value < 0.01 ? '< $0.01' : usdFormat.format(value))

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export const formatAmount = (amount: bigint, decimals: number, maxFraction = 4) => {
  const [whole = '0', fraction = ''] = formatUnits(amount, decimals).split('.')
  const trimmed = fraction.slice(0, maxFraction).replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return trimmed ? `${grouped}.${trimmed}` : grouped
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export const timeAgo = (iso?: string) => {
  if (!iso) return 'never'
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export const errorMessage = (error: unknown) => {
  if (error && typeof error === 'object' && 'shortMessage' in error) return String(error.shortMessage)
  return error instanceof Error ? error.message : String(error)
}
