import { useEffect, useMemo, useState } from 'react'
import { formatEther } from 'viem'
import { decodeCalldata, type DecodedCall, type DecodedValue } from '@msa/core'
import type { ActionDetail, ChainConfig, DeployedSafe, FollowUp, SafeRecord, SafeTxRecord, TxAction, MetaTx } from '@msa/core'
import { actionRegistry } from '../plugins.ts'
import { clientFor, useStorage } from '../state/data.tsx'
import { AddressTag, Badge, CopyButton, Modal } from './ui.tsx'

const EXPIRY_MARGIN_SECONDS = 15
const POLL_MS = 15_000
const POLL_FOR_MS = 60 * 60_000

export const useNow = (intervalMs = 1000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export const secondsLeft = (action: TxAction, now: number) =>
  action.expiresAt ? action.expiresAt - EXPIRY_MARGIN_SECONDS - now / 1000 : Infinity

export const isExpired = (action: TxAction, now: number) => secondsLeft(action, now) <= 0

const countdown = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export const DetailsList = ({ details }: { details: ActionDetail[] }) => (
  <div className="details-list">
    {details.map((detail) => (
      <div key={detail.label} className={detail.strong ? 'is-strong' : ''}>
        <span>{detail.label}</span>
        <span>{detail.value}</span>
      </div>
    ))}
  </div>
)

export const ExpiryBanner = ({
  action,
  signaturesNeeded,
  done,
}: {
  action: TxAction
  signaturesNeeded: number
  done?: boolean
}) => {
  const now = useNow()
  if (!action.expiresAt || done) return null
  const left = secondsLeft(action, now)
  const deadline = new Date(action.expiresAt * 1000).toLocaleTimeString()
  if (left <= 0) {
    return (
      <div className="expiry is-expired">
        <strong>Expired at {deadline}.</strong> This can no longer be signed or executed. Delete it and create a new one with a
        fresh quote.
      </div>
    )
  }
  return (
    <div className={`expiry ${left < 90 ? 'is-urgent' : ''}`}>
      <span className="expiry-clock">{countdown(left)}</span>
      <span>
        left. All {signaturesNeeded} signature{signaturesNeeded === 1 ? '' : 's'} <strong>and</strong> the execution must happen
        before <strong>{deadline}</strong>. Have every signer ready before you start.
      </span>
    </div>
  )
}

export const FollowUpBadge = ({ followUp }: { followUp?: FollowUp }) => {
  if (!followUp) return <Badge>Not reported yet</Badge>
  const tone =
    followUp.state === 'done' ? 'good' : followUp.state === 'failed' ? 'bad' : followUp.state === 'needs-action' ? 'warn' : 'accent'
  return <Badge tone={tone}>{followUp.label}</Badge>
}

export const needsPolling = (record: SafeTxRecord) =>
  record.status === 'executed' &&
  !!record.executedTxHash &&
  !!actionRegistry.get(record.action.pluginId)?.status &&
  (!record.followUp || record.followUp.state === 'progress') &&
  (!record.executedAt || Date.now() - Date.parse(record.executedAt) < POLL_FOR_MS)

export const useFollowUpPolling = (
  records: SafeTxRecord[],
  chain: ChainConfig | undefined,
  safe: SafeRecord | null | undefined,
) => {
  const storage = useStorage()
  const ids = records
    .filter(needsPolling)
    .map((record) => record.id)
    .join(',')

  useEffect(() => {
    if (!ids || !chain || !safe?.address) return
    let cancelled = false
    const poll = async () => {
      for (const id of ids.split(',')) {
        const record = await storage.get('txs', id as SafeTxRecord['id'])
        if (!record || !needsPolling(record) || cancelled) continue
        const plugin = actionRegistry.get(record.action.pluginId)!
        const next = await plugin.status!(record.action, record.executedTxHash!, {
          chain,
          safe: safe as DeployedSafe,
          client: clientFor(chain),
        }).catch(() => null)
        if (next && !cancelled && (next.label !== record.followUp?.label || next.state !== record.followUp?.state || next.url !== record.followUp?.url)) {
          await storage.put('txs', { ...record, followUp: { ...next, at: new Date().toISOString() } })
        }
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [ids, chain, safe, storage])
}

const dataBytes = (data: string) => Math.max(0, (data.length - 2) / 2)

const DecodedValueRow = ({ item }: { item: DecodedValue }) => (
  <li>
    <span className="decoded-name">{item.name}</span> <span className="muted tiny">{item.type}</span>
    {item.call ? (
      <DecodedCallView call={item.call} />
    ) : item.children ? (
      <ul className="decoded-list">
        {item.children.map((child, index) => (
          <DecodedValueRow key={index} item={child} />
        ))}
      </ul>
    ) : (
      <div className="mono tiny break">{item.value === '0x' ? 'empty' : item.value}</div>
    )}
  </li>
)

const DecodedCallView = ({ call }: { call: DecodedCall }) => (
  <div className="decoded-call">
    <code className="decoded-fn">{call.signature}</code>
    <ul className="decoded-list">
      {call.args.map((arg, index) => (
        <DecodedValueRow key={index} item={arg} />
      ))}
    </ul>
  </div>
)

const CallRow = ({ call, index, chain }: { call: MetaTx; index: number; chain: ChainConfig }) => {
  const [open, setOpen] = useState(false)
  const hasData = call.data !== '0x'
  const decoded = useMemo(() => (hasData ? decodeCalldata(call.data) : null), [call.data, hasData])
  const value = BigInt(call.value)
  return (
    <div className="call">
      <div className="call-head">
        <span className="muted tiny">Call {index + 1}</span>
        <AddressTag address={call.to} chain={chain} />
      </div>
      <div className="call-meta small">
        {value > 0n && (
          <span>
            {formatEther(value)} {chain.nativeSymbol}
          </span>
        )}
        {hasData ? (
          <>
            <span className="mono">{decoded ? decoded.functionName : call.data.slice(0, 10)}</span>
            <span className="muted">{dataBytes(call.data).toLocaleString()} bytes</span>
            <button className="link-btn" onClick={() => setOpen(true)}>
              View data
            </button>
          </>
        ) : (
          <span className="muted">No data</span>
        )}
      </div>
      <Modal open={open} title={`Call ${index + 1} data`} onClose={() => setOpen(false)}>
        <div className="stack gap-md call-modal">
          {decoded ? (
            <DecodedCallView call={decoded} />
          ) : (
            <p className="muted small">Unknown function, no ABI to decode it with.</p>
          )}
          <details className="raw-data" open={!decoded}>
            <summary className="small">Raw data ({dataBytes(call.data).toLocaleString()} bytes)</summary>
            <div className="row gap-sm">
              <span className="grow" />
              <CopyButton value={call.data} />
            </div>
            <pre className="call-data mono tiny">{call.data}</pre>
          </details>
        </div>
      </Modal>
    </div>
  )
}

export const CallList = ({ calls, chain }: { calls: MetaTx[]; chain: ChainConfig }) => (
  <div className="stack gap-sm">
    {calls.map((call, index) => (
      <CallRow key={index} call={call} index={index} chain={chain} />
    ))}
  </div>
)

export const ChecksSummary = ({ checks }: { checks?: string[] }) =>
  checks?.length ? (
    <details className="checks-summary">
      <summary>
        ✓ {checks.length} safety check{checks.length === 1 ? '' : 's'} passed
      </summary>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check}>{check}</li>
        ))}
      </ul>
    </details>
  ) : null
