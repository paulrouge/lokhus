import { useEffect, useMemo, useState } from 'react'
import { zeroAddress } from 'viem'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  SODAX_CHAINS,
  fetchSodaxPrices,
  readBalances,
  readSafe,
  retry,
  type Balance,
  type DeployedSafe,
  type OnchainSafe,
  type SafeTxRecord,
  type ChainConfig,
  lendPositionOf,
  creationSetup,
} from '@msa/core'
import { clientFor, useChains, useCollection, useDoc, useStorage } from '../state/data.tsx'
import { useWallet } from '../state/wallet.tsx'
import { AddressTag, Badge, Breadcrumb, Button, Card, ChainPill, Empty, ErrorNote, Stat } from '../components/ui.tsx'
import { NotesBox } from '../components/Notes.tsx'
import { ActivityCard } from '../components/Activity.tsx'
import { OtherChainsCard } from '../components/OtherChains.tsx'
import { isExpired, secondsLeft, useFollowUpPolling, useNow } from '../components/ActionPanels.tsx'
import { TokenIcon, useLogoCheck } from '../actions/SodaxSwapForm.tsx'
import { formatApy, MIN_LISTED_APY, useLendData } from '../actions/SodaxLendForm.tsx'
import { errorMessage, formatAmount, formatUsd, timeAgo } from '../lib/format.ts'
import { describeNonces, missingNonces } from '../lib/nonces.ts'

const PendingClock = ({ tx }: { tx: SafeTxRecord }) => {
  const now = useNow()
  if (!tx.action.expiresAt) return null
  if (isExpired(tx.action, now)) return <Badge tone="bad">Expired</Badge>
  const left = Math.floor(secondsLeft(tx.action, now))
  return <Badge tone="warn">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`}</Badge>
}

type LendData = ReturnType<typeof useLendData>
type LogoCheck = ReturnType<typeof useLogoCheck>

const EarnCard = ({ safe, prices, lend }: { safe: DeployedSafe; prices: Map<string, number> | null; lend: LendData }) => {
  const { markets, positions, balances, error } = lend
  const [showAll, setShowAll] = useState(false)
  const base = `/safes/${encodeURIComponent(safe.id)}/new`
  const rows = markets
    .map((market) => {
      const supplied = positions ? lendPositionOf(market, positions, markets) : 0n
      const held = balances.get(market.address === zeroAddress ? zeroAddress : market.address.toLowerCase()) ?? 0n
      const price = prices?.get(market.address.toLowerCase())
      const suppliedUsd = price === undefined ? 0 : (Number(supplied) / 10 ** market.decimals) * price
      return { market, supplied, held, suppliedUsd }
    })
    .filter((row) => row.market.supplyApy >= MIN_LISTED_APY || row.supplied > 0n)
    .sort(
      (a, b) =>
        Number(b.supplied > 0n) - Number(a.supplied > 0n) ||
        Number(b.held > 0n) - Number(a.held > 0n) ||
        b.market.supplyApy - a.market.supplyApy,
    )
  const relevant = rows.filter((row) => row.supplied > 0n || row.held > 0n)
  const visible = showAll || relevant.length === 0 ? rows : relevant
  const totalUsd = rows.reduce((sum, row) => sum + row.suppliedUsd, 0)
  const earningUsd = rows.reduce((sum, row) => sum + row.suppliedUsd * row.market.supplyApy, 0)

  return (
    <Card title="Earn" subtitle={totalUsd > 0 ? undefined : 'Lend idle tokens on the SODAX money market and earn interest.'}>
      {totalUsd > 0 && (
        <div className="earn-summary">
          <span className="earn-summary-label">Earning</span>
          <span className="earn-summary-value">≈ {formatUsd(earningUsd)} a year</span>
          <span className="muted small">
            {formatUsd(earningUsd / 12)} a month on {formatUsd(totalUsd)} supplied
          </span>
        </div>
      )}
      {error && <p className="muted small">{error}</p>}
      {markets.length === 0 && !error ? (
        <p className="muted small">Loading markets…</p>
      ) : (
        <div className="earn-list">
          {visible.map(({ market, supplied, held }) => {
            const link = (action: string) => `${base}?action=${action}&token=${market.address}`
            return (
              <div key={market.address} className="earn-row">
                <TokenIcon symbol={market.symbol} />
                <span className="grow">
                  <span className="row gap-xs">
                    <strong>{market.symbol}</strong>
                    <span className="earn-apy">{formatApy(market.supplyApy)} APY</span>
                  </span>
                  <span className="muted tiny block">
                    {supplied > 0n ? (
                      <>
                        {formatAmount(supplied, market.decimals)} supplied ·{' '}
                        <span className="text-good">
                          +{formatYield(supplied, market.decimals, market.supplyApy)} {market.symbol} a year
                        </span>
                      </>
                    ) : held > 0n ? (
                      `${formatAmount(held, market.decimals)} idle, could earn ${formatYield(held, market.decimals, market.supplyApy)} ${market.symbol} a year`
                    ) : (
                      'Not held'
                    )}
                  </span>
                </span>
                <span className="earn-actions">
                  {held > 0n && (
                    <Link to={link('sodax-supply')}>
                      <Button size="sm" variant={supplied > 0n ? 'secondary' : 'primary'}>
                        {supplied > 0n ? 'Add' : 'Supply'}
                      </Button>
                    </Link>
                  )}
                  {supplied > 0n && (
                    <Link to={link('sodax-withdraw')}>
                      <Button size="sm" variant="ghost">
                        Withdraw
                      </Button>
                    </Link>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {relevant.length > 0 && rows.length > relevant.length && (
        <button className="link-btn small" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Only my tokens' : `Show all ${rows.length} markets`}
        </button>
      )}
    </Card>
  )
}

const formatYield = (amount: bigint, decimals: number, apy: number) => {
  const value = (Number(amount) / 10 ** decimals) * apy
  return value.toLocaleString('en-US', { maximumSignificantDigits: 3 })
}

const TxRow = ({
  tx,
  safe,
  threshold,
  missing,
}: {
  tx: SafeTxRecord
  safe: DeployedSafe
  threshold: number
  missing: bigint[]
}) => (
  <Link to={`/safes/${encodeURIComponent(safe.id)}/tx/${tx.id}`} className="tx-row">
    <span className="tx-nonce">#{tx.tx.nonce}</span>
    <span className="grow">
      <strong>{tx.action.summary}</strong>
      <span className="muted tiny block">Created {timeAgo(tx.createdAt)}</span>
    </span>
    {tx.status === 'pending' && <PendingClock tx={tx} />}
    {missing.length > 0 && <Badge tone="bad">Blocked: {describeNonces(missing)} missing</Badge>}
    {tx.status === 'pending' ? (
      <Badge tone={tx.signatures.length >= threshold ? 'good' : 'accent'}>
        {tx.signatures.length}/{threshold} signed
      </Badge>
    ) : (
      <Badge tone={tx.status === 'executed' ? 'good' : 'neutral'}>{tx.status}</Badge>
    )}
  </Link>
)

const tokenKey = (token: string | undefined) => (token ?? zeroAddress).toLowerCase()

const balanceUsd = (balance: Balance, prices: Map<string, number> | null) => {
  const price = prices?.get(tokenKey(balance.token))
  return price === undefined ? undefined : (Number(balance.amount) / 10 ** balance.decimals) * price
}

const sumUsd = (balances: Balance[], prices: Map<string, number> | null) =>
  balances.reduce((sum, balance) => sum + (balanceUsd(balance, prices) ?? 0), 0)

const BalancesCard = ({
  balances,
  earning = [],
  prices,
  logoCheck,
}: {
  balances: Balance[] | null
  earning?: Balance[]
  prices: Map<string, number> | null
  logoCheck: LogoCheck
}) => {
  const earningBy = new Map(earning.map((entry) => [tokenKey(entry.token), entry]))
  const rows = balances
    ? [
        ...balances.map((held) => ({ held, earned: earningBy.get(tokenKey(held.token)) })),
        ...earning
          .filter((entry) => !balances.some((held) => tokenKey(held.token) === tokenKey(entry.token)))
          .map((entry) => ({ held: { ...entry, amount: 0n }, earned: entry })),
      ]
    : []
  const earningUsd = sumUsd(earning, prices)
  const subtitle =
    balances && prices?.size
      ? `${formatUsd(sumUsd(balances, prices) + earningUsd)} total${earningUsd > 0 ? ` · ${formatUsd(earningUsd)} earning` : ''}`
      : undefined

  return (
    <Card title="Balances" subtitle={subtitle}>
      {!balances ? (
        <p className="muted small">Loading balances…</p>
      ) : (
        <div className="balances">
          {rows.map(({ held, earned }) => {
            const total = { ...held, amount: held.amount + (earned?.amount ?? 0n) }
            const usd = balanceUsd(total, prices)
            return (
              <div key={held.symbol + (held.token ?? '')} className={`balance ${total.amount === 0n ? 'is-zero' : ''}`}>
                <TokenIcon symbol={held.symbol} trusted={logoCheck.trusted(held.symbol, held.token)} stock={logoCheck.isStock(held.token)} />
                <span className="grow">
                  {held.symbol}
                  {earned && (
                    <span className="muted tiny block">
                      {formatAmount(held.amount, held.decimals)} in Safe ·{' '}
                      <span className="text-good">{formatAmount(earned.amount, earned.decimals)} earning</span>
                    </span>
                  )}
                </span>
                <span className="balance-amount">
                  <strong className="mono">{formatAmount(total.amount, total.decimals)}</strong>
                  {usd !== undefined && <span className="muted small mono">{formatUsd(usd)}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

const SodaxCards = ({
  safe,
  chain,
  balances,
  prices,
  logoCheck,
}: {
  safe: DeployedSafe
  chain: ChainConfig
  balances: Balance[] | null
  prices: Map<string, number> | null
  logoCheck: LogoCheck
}) => {
  const context = useMemo(() => ({ chain, safe, client: clientFor(chain) }), [chain, safe])
  const lend = useLendData(context)
  const earning = useMemo(
    () =>
      lend.positions
        ? lend.markets.flatMap((market) => {
            const amount = lendPositionOf(market, lend.positions!, lend.markets)
            if (amount === 0n) return []
            const listed = balances?.find((held) => tokenKey(held.token) === tokenKey(market.address))
            const decimals = listed?.decimals ?? market.decimals
            const scaled = decimals >= market.decimals ? amount * 10n ** BigInt(decimals - market.decimals) : amount / 10n ** BigInt(market.decimals - decimals)
            return [{ symbol: listed?.symbol ?? market.symbol, decimals, token: market.address === zeroAddress ? undefined : market.address, amount: scaled }]
          })
        : [],
    [lend.markets, lend.positions, balances],
  )
  return (
    <>
      <BalancesCard balances={balances} earning={earning} prices={prices} logoCheck={logoCheck} />
      <EarnCard safe={safe} prices={prices} lend={lend} />
    </>
  )
}

export const SafeView = () => {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const storage = useStorage()
  const { byId } = useChains()
  const { doc: safe, loading } = useDoc('safes', id)
  const { items: txs } = useCollection('txs', { safeId: id })
  const { connection } = useWallet()
  const [onchain, setOnchain] = useState<OnchainSafe | null>(null)
  const [balances, setBalances] = useState<Balance[] | null>(null)
  const [prices, setPrices] = useState<Map<string, number> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const chain = safe ? byId.get(safe.chainId) : undefined
  useFollowUpPolling(txs, chain, safe)
  const logoCheck = useLogoCheck(safe?.chainId ?? 0)

  useEffect(() => {
    if (safe?.status === 'draft') navigate(`/safes/new/${encodeURIComponent(safe.id)}`, { replace: true })
  }, [safe, navigate])

  useEffect(() => {
    if (!safe?.address || !chain) return
    const client = clientFor(chain)
    const address = safe.address
    let cancelled = false
    retry(() => Promise.all([readSafe(client, address), readBalances(client, chain, address)]))
      .then(([state, amounts]) => {
        if (cancelled) return
        setOnchain(state)
        setBalances(amounts)
      })
      .catch((cause) => !cancelled && setError(errorMessage(cause)))
    fetchSodaxPrices(chain.chainId)
      .then((map) => !cancelled && setPrices(map))
      .catch(() => !cancelled && setPrices(new Map()))
    return () => {
      cancelled = true
    }
  }, [safe?.address, chain])

  useEffect(() => {
    if (!safe || !onchain) return
    const ownersChanged = onchain.owners.join() !== safe.owners.join()
    if (ownersChanged || onchain.threshold !== safe.threshold) {
      void (async () => {
        const deploySetup = chain ? await creationSetup(chain, safe).catch(() => null) : null
        await storage.put('safes', { ...safe, owners: onchain.owners, threshold: onchain.threshold, deploySetup: deploySetup ?? safe.deploySetup })
      })()
    }
    for (const tx of txs) {
      if (tx.status === 'pending' && BigInt(tx.tx.nonce) < onchain.nonce) void storage.put('txs', { ...tx, status: 'replaced' })
    }
  }, [onchain, safe, txs, storage, chain])

  if (loading && !safe) return <p className="muted">Loading…</p>
  if (!safe || !safe.address) return <Empty title="Safe not found" action={<Link to="/">Back to Safes</Link>} />

  const deployed = safe as DeployedSafe
  const pending = txs.filter((tx) => tx.status === 'pending').sort((a, b) => Number(BigInt(a.tx.nonce) - BigInt(b.tx.nonce)))
  const isOwner = !!connection && safe.owners.some((owner) => owner.toLowerCase() === connection.address.toLowerCase())

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div className="stack gap-xs">
          <Breadcrumb items={[{ label: 'Safes', to: '/' }, { label: safe.name }]} />
          <div className="row gap-sm">
            <ChainPill chain={chain} />
            {connection && (
              <Badge tone={isOwner ? 'good' : 'neutral'}>
                {isOwner ? 'You are an owner' : 'Connected signer is not an owner'}
              </Badge>
            )}
          </div>
          {renaming ? (
            <input
              className="title-input"
              autoFocus
              defaultValue={safe.name}
              onBlur={(event) => {
                setRenaming(false)
                const name = event.target.value.trim()
                if (name && name !== safe.name) void storage.put('safes', { ...safe, name })
              }}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
          ) : (
            <h1 className="editable" onClick={() => setRenaming(true)} title="Rename">
              {safe.name}
            </h1>
          )}
          <AddressTag address={safe.address} chain={chain} full />
        </div>
        <div className="row gap-sm">
          {chain && SODAX_CHAINS[chain.chainId] && (
            <Link to={`/safes/${encodeURIComponent(safe.id)}/new?action=sodax-swap`} className="btn btn-secondary btn-md">
              Swap
            </Link>
          )}
          {chain && SODAX_CHAINS[chain.chainId]?.stocks && (
            <Link to={`/safes/${encodeURIComponent(safe.id)}/new?action=sodax-stocks`} className="btn btn-secondary btn-md">
              Stocks
            </Link>
          )}
          <Link to={`/safes/${encodeURIComponent(safe.id)}/new`} className="btn btn-primary btn-md">
            New transaction
          </Link>
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="stats">
        <Stat label="Policy" value={`${safe.threshold} of ${safe.owners.length}`} />
        <Stat label="Next nonce" value={onchain ? onchain.nonce.toString() : '…'} />
        <Stat label="Pending" value={pending.length} />
        <Stat label="Version" value={onchain?.version ?? '…'} />
      </div>

      <Card title="Notes">
        <NotesBox entityType="safe" entityId={safe.id} placeholder="What this Safe is for, routines, reminders…" />
      </Card>

      <div className="split">
        <div className="stack gap-md">
          <Card title="Queue" subtitle="Transactions waiting for signatures or execution.">
            {pending.length === 0 ? (
              <p className="muted small">Nothing waiting. Create a transaction to get started.</p>
            ) : (
              <div className="stack">
                {pending.map((tx) => (
                  <TxRow
                    key={tx.id}
                    tx={tx}
                    safe={deployed}
                    threshold={safe.threshold}
                    missing={missingNonces(tx, onchain?.nonce ?? null, txs)}
                  />
                ))}
              </div>
            )}
          </Card>


          {chain && <ActivityCard safe={safe} chain={chain} txs={txs} />}
        </div>

        <div className="stack gap-md">
          {chain && SODAX_CHAINS[chain.chainId] ? (
            <SodaxCards safe={deployed} chain={chain} balances={balances} prices={prices} logoCheck={logoCheck} />
          ) : (
            <BalancesCard balances={balances} prices={prices} logoCheck={logoCheck} />
          )}

          {chain && <OtherChainsCard safe={deployed} chain={chain} />}

          <Card title="Owners" subtitle={`${safe.threshold} signature${safe.threshold === 1 ? '' : 's'} required`}>
            <div className="stack gap-sm">
              {safe.owners.map((owner) => (
                <AddressTag key={owner} address={owner} chain={chain} />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
