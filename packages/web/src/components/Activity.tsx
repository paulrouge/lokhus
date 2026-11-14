import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createChainClient,
  erc20Abi,
  explorerLink,
  formatTokenAmount,
  type ActivityItem,
  type ActivityKind,
  type Address,
  type ChainConfig,
  type SafeRecord,
  type SafeTxRecord,
} from '@msa/core'
import { usePagedCollection, useStorage } from '../state/data.tsx'
import { actionRegistry } from '../plugins.ts'
import { FollowUpBadge } from './ActionPanels.tsx'
import { useActivitySync } from '../lib/activitySync.ts'
import { Button, Card, ErrorNote } from './ui.tsx'
import { errorMessage, shortAddress, timeAgo } from '../lib/format.ts'

const ICONS: Record<ActivityKind, { glyph: string; tone: string }> = {
  executed: { glyph: '↗', tone: 'out' },
  failed: { glyph: '!', tone: 'bad' },
  received: { glyph: '↙', tone: 'in' },
  'token-received': { glyph: '↙', tone: 'in' },
  'owner-added': { glyph: '+', tone: 'settings' },
  'owner-removed': { glyph: '−', tone: 'settings' },
  'threshold-changed': { glyph: '⚙', tone: 'settings' },
}

const PAGE_SIZE = 50

const tracksFollowUp = (record: SafeTxRecord) => !!actionRegistry.get(record.action.pluginId)?.status

const listedToken = (chain: ChainConfig, token?: Address) =>
  token ? chain.tokens.find((candidate) => candidate.address.toLowerCase() === token.toLowerCase()) : undefined

const isHidden = (item: ActivityItem, chain: ChainConfig) => {
  if (item.kind !== 'token-received') return false
  if (!listedToken(chain, item.token)) return true
  return item.amountRaw === '0'
}

const itemTitle = (item: ActivityItem, chain: ChainConfig, record?: SafeTxRecord) => {
  if (record) return record.action.summary
  const token = listedToken(chain, item.token)
  if (item.kind === 'token-received' && token && item.amountRaw && item.counterparty) {
    return `Received ${formatTokenAmount(BigInt(item.amountRaw), token.decimals)} ${token.symbol} from ${shortAddress(item.counterparty)}`
  }
  return item.summary
}

const TrustTokenButton = ({ chain, token }: { chain: ChainConfig; token: Address }) => {
  const storage = useStorage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trust = async () => {
    setBusy(true)
    setError(null)
    try {
      const client = createChainClient(chain)
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      ])
      const clash = [chain.nativeSymbol, ...chain.tokens.map((listed) => listed.symbol)].find(
        (existing) => existing.toLowerCase() === symbol.trim().toLowerCase(),
      )
      if (clash) {
        window.alert(`Refused: this contract calls itself ${symbol}, but ${clash} is already on your ${chain.name} list. It is almost certainly a fake.\n\n${token}`)
        return setError(`Fake ${symbol}`)
      }
      const message = `Trust this token on ${chain.name}? Only do this for tokens you recognise.\n\nSymbol: ${symbol}\nDecimals: ${decimals}\nAddress: ${token}`
      if (!window.confirm(message)) return
      await storage.put('chains', { ...chain, tokens: [...chain.tokens, { address: token, symbol, decimals }] })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant="ghost" busy={busy} onClick={() => void trust()} title={error ?? undefined}>
      {error ? (error.startsWith('Fake') ? error : 'Not a token') : 'Trust token'}
    </Button>
  )
}

const ActivityRow = ({
  item,
  chain,
  record,
  safeId,
  hidden,
}: {
  item: ActivityItem
  chain: ChainConfig
  record?: SafeTxRecord
  safeId: string
  hidden: boolean
}) => {
  const icon = ICONS[item.kind]
  const title = itemTitle(item, chain, record)
  const when = item.timestamp ? timeAgo(new Date(item.timestamp * 1000).toISOString()) : `block ${item.blockNumber}`
  return (
    <div className={`activity-row ${hidden ? 'is-hidden' : ''}`}>
      <span className={`activity-icon tone-${hidden ? 'muted' : icon.tone}`}>{icon.glyph}</span>
      <span className="grow">
        {record ? (
          <Link to={`/safes/${encodeURIComponent(safeId)}/tx/${record.id}`} className="activity-title link-plain">
            {title}
          </Link>
        ) : (
          <span className="activity-title">{title}</span>
        )}
        <span className="muted tiny block">
          {item.nonce ? `#${item.nonce} · ` : ''}
          {when}
          {hidden && (item.amountRaw === '0' && listedToken(chain, item.token) ? ' · zero-value, likely address poisoning' : ' · token not on your list')}
          {record?.followUp?.message ? ` · ${record.followUp.message}` : ''}
        </span>
      </span>
      {record && tracksFollowUp(record) && <FollowUpBadge followUp={record.followUp} />}
      {hidden && item.token && !listedToken(chain, item.token) && <TrustTokenButton chain={chain} token={item.token} />}
      <a className="icon-btn" href={explorerLink(chain, 'tx', item.txHash)} target="_blank" rel="noreferrer" title="Open in explorer">
        ↗
      </a>
    </div>
  )
}

const UnsyncedRow = ({ record, safeId, chain }: { record: SafeTxRecord; safeId: string; chain: ChainConfig }) => (
  <div className="activity-row">
    <span className="activity-icon tone-out">↗</span>
    <span className="grow">
      <Link to={`/safes/${encodeURIComponent(safeId)}/tx/${record.id}`} className="activity-title link-plain">
        {record.action.summary}
      </Link>
      <span className="muted tiny block">
        #{record.tx.nonce} · executed, waiting for the next activity sync
        {record.followUp?.message ? ` · ${record.followUp.message}` : ''}
      </span>
    </span>
    <FollowUpBadge followUp={record.followUp} />
    {record.executedTxHash && (
      <a className="icon-btn" href={explorerLink(chain, 'tx', record.executedTxHash)} target="_blank" rel="noreferrer" title="Open in explorer">
        ↗
      </a>
    )}
  </div>
)

export const ActivityCard = ({ safe, chain, txs }: { safe: SafeRecord; chain: ChainConfig; txs: SafeTxRecord[] }) => {
  const { items, hasMore, loadMore, loading } = usePagedCollection('activity', {
    filter: { safeId: safe.id },
    order: [
      { field: 'blockNumber', numeric: true },
      { field: 'logIndex', numeric: true },
    ],
    direction: 'desc',
    limit: PAGE_SIZE,
  })
  const { syncing, progress, error, notice, sync } = useActivitySync(safe, chain)
  const [showHidden, setShowHidden] = useState(false)
  const records = new Map(txs.map((tx) => [tx.id.toLowerCase(), tx]))
  const hiddenCount = items.filter((item) => isHidden(item, chain)).length
  const visible = showHidden ? items : items.filter((item) => !isHidden(item, chain))
  const seenSafeTxs = new Set(items.flatMap((item) => (item.safeTxHash ? [item.safeTxHash.toLowerCase()] : [])))
  const oldestLoaded = items[items.length - 1]?.timestamp
  const unsynced = txs
    .filter((tx) => tx.status === 'executed' && tracksFollowUp(tx) && !seenSafeTxs.has(tx.id.toLowerCase()))
    .filter((tx) => !hasMore || oldestLoaded === undefined || Date.parse(tx.createdAt) / 1000 > oldestLoaded)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const abandoned = txs.filter((tx) => tx.status === 'replaced')

  return (
    <Card
      title="Activity"
      subtitle={
        syncing
          ? `Syncing${progress !== undefined ? ` · ${Math.round(progress * 100)}%` : '…'}`
          : safe.scannedAt
            ? `Up to date as of ${timeAgo(safe.scannedAt)}`
            : 'Not synced yet'
      }
      actions={
        <Button size="sm" variant="ghost" busy={syncing} onClick={() => void sync()}>
          Refresh
        </Button>
      }
    >
      <ErrorNote error={error} />
      {notice && <p className="hint">{notice}</p>}
      {visible.length === 0 && unsynced.length === 0 ? (
        <p className="muted small">{syncing || loading ? 'Reading the chain…' : 'No onchain activity yet.'}</p>
      ) : (
        <div className="stack activity-scroll" tabIndex={0} aria-label="Activity">
          {unsynced.map((tx) => (
            <UnsyncedRow key={tx.id} record={tx} safeId={safe.id} chain={chain} />
          ))}
          {visible.map((item) => (
            <ActivityRow
              key={item.id}
              item={item}
              chain={chain}
              safeId={safe.id}
              hidden={isHidden(item, chain)}
              record={item.safeTxHash ? records.get(item.safeTxHash.toLowerCase()) : undefined}
            />
          ))}
          {hasMore && (
            <Button size="sm" variant="ghost" className="activity-more" busy={loading} onClick={() => void loadMore()}>
              Load older activity
            </Button>
          )}
        </div>
      )}
      {hiddenCount > 0 && (
        <button className="text-toggle" onClick={() => setShowHidden((value) => !value)}>
          {showHidden ? 'Hide filtered transfers' : `${hiddenCount} filtered transfer${hiddenCount === 1 ? '' : 's'} hidden${hasMore ? ' so far' : ''} (unlisted tokens or zero-value spam)`}
        </button>
      )}
      {abandoned.length > 0 && (
        <details className="abandoned">
          <summary className="muted small">
            {abandoned.length} transaction{abandoned.length === 1 ? '' : 's'} never executed (nonce used elsewhere)
          </summary>
          <div className="stack">
            {abandoned.map((tx) => (
              <Link key={tx.id} to={`/safes/${encodeURIComponent(safe.id)}/tx/${tx.id}`} className="activity-row">
                <span className="activity-icon tone-muted">×</span>
                <span className="grow activity-title">{tx.action.summary}</span>
                <span className="muted tiny">#{tx.tx.nonce}</span>
              </Link>
            ))}
          </div>
        </details>
      )}
    </Card>
  )
}
