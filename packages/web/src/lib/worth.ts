import { useEffect, useState } from 'react'
import { zeroAddress } from 'viem'
import {
  fetchLendMarkets,
  fetchSodaxPrices,
  lendPositionOf,
  readBalances,
  readLendPositions,
  type ChainConfig,
  type DeployedSafe,
} from '@msa/core'
import { clientFor } from '../state/data.tsx'
import { sodaxHubClient } from '../plugins.ts'

export interface SafeWorth {
  usd: number
  apy: number
}

const units = (amount: bigint, decimals: number) => Number(amount) / 10 ** decimals

const readWorth = async (safe: DeployedSafe, chain: ChainConfig): Promise<SafeWorth | null> => {
  const client = clientFor(chain)
  const [balances, prices, markets] = await Promise.all([
    readBalances(client, chain, safe.address),
    fetchSodaxPrices(chain.chainId),
    fetchLendMarkets(chain.chainId).catch(() => []),
  ])
  if (prices.size === 0) return null
  const priceOf = (token: string) => prices.get(token.toLowerCase()) ?? 0
  const held = balances.reduce((sum, balance) => sum + units(balance.amount, balance.decimals) * priceOf(balance.token ?? zeroAddress), 0)
  const hubClient = sodaxHubClient({ chain, safe, client })
  const positions = hubClient
    ? await readLendPositions(chain.chainId, safe.address, hubClient, markets).catch(() => new Map<string, bigint>())
    : new Map<string, bigint>()
  const supplied = markets.map((market) => ({
    usd: units(lendPositionOf(market, positions, markets), market.decimals) * priceOf(market.address),
    apy: market.supplyApy,
  }))
  const usd = held + supplied.reduce((sum, row) => sum + row.usd, 0)
  const earning = supplied.reduce((sum, row) => sum + row.usd * row.apy, 0)
  return { usd, apy: usd > 0 ? earning / usd : 0 }
}

export const useSafeWorth = (safe: DeployedSafe | undefined, chain: ChainConfig | undefined) => {
  const [worth, setWorth] = useState<SafeWorth | null | undefined>(undefined)
  useEffect(() => {
    if (!safe || !chain) return
    let cancelled = false
    readWorth(safe, chain)
      .then((value) => !cancelled && setWorth(value))
      .catch(() => !cancelled && setWorth(null))
    return () => {
      cancelled = true
    }
  }, [safe?.address, chain])
  return worth
}

const HIDE_AMOUNTS = 'lokhus.hideAmounts'

export const useHiddenAmounts = () => {
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_AMOUNTS) === '1')
  const toggle = () =>
    setHidden((current) => {
      localStorage.setItem(HIDE_AMOUNTS, current ? '0' : '1')
      return !current
    })
  return { hidden, toggle }
}
