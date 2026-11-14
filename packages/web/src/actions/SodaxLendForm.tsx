import { useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import {
  fetchLendMarkets,
  formatTokenAmount,
  lendPositionOf,
  readLendPositions,
  type ActionContext,
  type LendMarket,
} from '@msa/core'
import { sodaxHubClient } from '../plugins.ts'
import { errorMessage } from '../lib/format.ts'
import { TokenIcon, useSafeBalances } from './SodaxSwapForm.tsx'
import type { ActionFormProps } from './index.ts'

export const formatApy = (apy: number) => `${(apy * 100).toFixed(2)}%`

export const MIN_LISTED_APY = 0.02

export const useLendData = (context: ActionContext | undefined) => {
  const [markets, setMarkets] = useState<LendMarket[]>([])
  const [positions, setPositions] = useState<Map<string, bigint> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const chainId = context?.chain.chainId
  const safe = context?.safe.address

  useEffect(() => {
    if (!context || !chainId || !safe) return
    let cancelled = false
    const hubClient = sodaxHubClient(context)
    fetchLendMarkets(chainId)
      .then(async (list) => {
        if (cancelled) return
        setMarkets(list)
        if (!hubClient) throw new Error('Add Sonic on Chains to read your SODAX positions')
        const next = await readLendPositions(chainId, safe, hubClient, list)
        if (!cancelled) setPositions(next)
      })
      .catch((cause) => !cancelled && setError(errorMessage(cause)))
    return () => {
      cancelled = true
    }
  }, [chainId, safe])

  const balances = useSafeBalances(context!, markets)
  return { markets, positions, balances, error }
}

const holding = (balances: Map<string, bigint>, market: LendMarket) =>
  balances.get(market.address === '0x0000000000000000000000000000000000000000' ? market.address : market.address.toLowerCase()) ??
  0n

const LendForm = ({ input, onChange, context, mode }: ActionFormProps & { mode: 'supply' | 'withdraw' }) => {
  const { markets, positions, balances, error } = useLendData(context)
  const set = (patch: Record<string, string>) => onChange({ ...input, ...patch })
  const supplying = mode === 'supply'

  const available = (market: LendMarket) =>
    supplying ? holding(balances, market) : positions ? lendPositionOf(market, positions, markets) : 0n

  const sorted = useMemo(
    () =>
      markets
        .filter((market) => market.supplyApy >= MIN_LISTED_APY || (positions ? lendPositionOf(market, positions, markets) : 0n) > 0n)
        .sort(
          (a, b) =>
            Number(available(b) > 0n) - Number(available(a) > 0n) || b.supplyApy - a.supplyApy || a.symbol.localeCompare(b.symbol),
        ),
    [markets, balances, positions, mode],
  )
  const selected = markets.find((market) => market.address.toLowerCase() === (input.token ?? '').toLowerCase())

  useEffect(() => {
    if (!input.token && sorted[0] && available(sorted[0]) > 0n) set({ token: sorted[0].address })
  }, [sorted])

  const max = selected ? available(selected) : 0n
  let amount = 0n
  try {
    amount = selected ? parseUnits((input.amount ?? '').trim() || '0', selected.decimals) : 0n
  } catch {}
  const tooMuch = !!selected && amount > max
  const yearly = selected && amount > 0n ? Number(formatUnits(amount, selected.decimals)) * selected.supplyApy : 0

  if (error && markets.length === 0) return <p className="swap-error">Could not load the SODAX money market: {error}</p>

  return (
    <div className="stack gap-md">
      <div className="lend-intro">
        <strong>{supplying ? 'Supply to earn' : 'Withdraw to this Safe'}</strong>
        <span className="muted small">
          {supplying
            ? `The SODAX money market lives on Sonic. Your position is held by this Safe's own SODAX wallet there, and only this Safe can withdraw it.`
            : `Takes tokens out of the SODAX money market and sends them back to this Safe on ${context.chain.name}.`}
        </span>
      </div>

      {supplying && (
        <details className="explain">
          <summary>Where does the interest come from?</summary>
          <p>
            A money market is a lending pool. You put tokens in, others borrow them. Borrowers pay interest because they expect to make
            more with the money than the loan costs them, for example to trade, or to cover a need without selling assets they want to
            keep. That interest flows to the people who supplied the money, including you.
          </p>
          <p>
            Every loan is backed by collateral worth more than the loan, and that collateral is sold automatically if its value falls too
            far. The rate moves with demand: more borrowing, higher rate.
          </p>
          <p>
            Risks: a bug in the contracts, collateral that cannot be sold fast enough in a crash, and short waits to withdraw when most of
            the pool is lent out.
          </p>
        </details>
      )}

      <div className="lend-list">
        {sorted.length === 0 && <p className="muted small">Loading markets…</p>}
        {sorted.map((market) => {
          const own = available(market)
          const active = selected?.address === market.address
          const disabled = (supplying && market.frozen) || (!supplying && own === 0n)
          return (
            <button
              key={market.address}
              className={`lend-row ${active ? 'is-on' : ''}`}
              disabled={disabled}
              onClick={() => set({ token: market.address, amount: '' })}
            >
              <TokenIcon symbol={market.symbol} size={30} />
              <span className="grow">
                <strong>{market.symbol}</strong>
                <span className="muted tiny block">
                  {supplying ? 'In Safe' : 'Supplied'} {formatTokenAmount(own, market.decimals)}
                  {market.frozen ? ' · frozen' : ''}
                </span>
              </span>
              <span className="lend-apy">
                {formatApy(market.supplyApy)}
                <span className="muted tiny block">APY</span>
              </span>
            </button>
          )
        })}
      </div>

      {selected && (
        <div className={`swap-box ${tooMuch ? 'is-bad' : ''}`}>
          <div className="swap-box-head">
            <span>{supplying ? 'Amount to supply' : 'Amount to withdraw'}</span>
            <button className="swap-max" onClick={() => set({ amount: formatUnits(max, selected.decimals) })}>
              {supplying ? 'Safe balance' : 'Supplied'} {formatTokenAmount(max, selected.decimals)} · Max
            </button>
          </div>
          <div className="swap-box-row">
            <input
              className="swap-amount"
              inputMode="decimal"
              placeholder="0"
              value={input.amount ?? ''}
              onChange={(event) => set({ amount: event.target.value.replace(',', '.').replace(/[^0-9.]/g, '') })}
            />
            <span className="token-select is-static">
              <TokenIcon symbol={selected.symbol} />
              <strong>{selected.symbol}</strong>
            </span>
          </div>
          {tooMuch && <span className="swap-warning">{supplying ? 'More than the Safe holds' : 'More than is supplied'}</span>}
        </div>
      )}

      {selected && (
        <div className="details-list">
          <div className="is-strong">
            <span>Supply APY now</span>
            <span>{formatApy(selected.supplyApy)}</span>
          </div>
          {supplying && yearly > 0 && (
            <div>
              <span>At this rate, per year</span>
              <span>
                ≈ {yearly.toLocaleString(undefined, { maximumFractionDigits: 4 })} {selected.symbol}
              </span>
            </div>
          )}
          <div>
            <span>Supplied by this Safe</span>
            <span>
              {positions
                ? `${formatTokenAmount(lendPositionOf(selected, positions, markets), selected.decimals)} ${selected.symbol}`
                : '…'}
            </span>
          </div>
          <div>
            <span>Route</span>
            <span>
              {context.chain.chainId === 146
                ? 'Direct on Sonic, settles in the same transaction'
                : supplying
                  ? `${context.chain.name} → Sonic hub, relayed in about a minute`
                  : `Sonic hub → ${context.chain.name}, relayed in a few minutes`}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export const SodaxSupplyForm = (props: ActionFormProps) => <LendForm {...props} mode="supply" />

export const SodaxWithdrawForm = (props: ActionFormProps) => <LendForm {...props} mode="withdraw" />
