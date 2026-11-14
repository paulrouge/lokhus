import { useCallback, useEffect, useState } from 'react'
import { simulateSafeTx, type ChainConfig, type SafeTxRecord, type SimTokenChange, type SimulationResult } from '@msa/core'
import { clientFor } from '../state/data.tsx'
import { errorMessage, formatAmount, shortAddress, timeAgo } from '../lib/format.ts'
import { AddressTag, Badge, Button, Card, ErrorNote } from './ui.tsx'

type TokenFields = Pick<SimTokenChange, 'token' | 'symbol' | 'decimals' | 'listed'>

const tokenAmount = (amount: bigint, token: TokenFields) =>
  token.decimals === null ? `${amount} raw units` : formatAmount(amount, token.decimals, 6)

const TokenName = ({ token }: { token: TokenFields }) => (
  <>
    <span className="sim-symbol">{token.symbol ?? 'token'}</span>
    {!token.listed && token.token !== 'native' && <span className="muted tiny">unlisted {shortAddress(token.token)}</span>}
  </>
)

const Change = ({ change }: { change: SimTokenChange }) => {
  const outgoing = change.amount < 0n
  return (
    <span className="sim-change">
      <span className={`mono ${outgoing ? 'text-bad' : 'text-good'}`}>
        {outgoing ? '−' : '+'}
        {tokenAmount(outgoing ? -change.amount : change.amount, change)}
      </span>
      <TokenName token={change} />
    </span>
  )
}

const Outcome = ({ result, chain }: { result: SimulationResult; chain: ChainConfig }) => {
  const setupChanged = result.setupChanges.length > 0
  return (
    <div className="stack gap-sm">
      {result.success ? (
        <p className={setupChanged ? 'hint' : 'hint-good'}>
          {setupChanged ? 'Succeeds, and changes how your Safe is controlled.' : 'Succeeds.'}
          {result.nonceOverridden && ' Simulated as if the transactions before it had run; their effects are not included.'}
        </p>
      ) : (
        <div className="error-note">Would fail: {result.revertReason}. Executing it now would revert.</div>
      )}

      {setupChanged && (
        <div className="error-note stack gap-xs">
          <strong>Safe setup changes</strong>
          {result.setupChanges.map((change) => (
            <span key={change}>{change}</span>
          ))}
        </div>
      )}

      {result.mode === 'outcome-only' && (
        <p className="muted small">This RPC cannot trace effects, so only success or failure is shown. Add an RPC that supports eth_simulateV1 to see balance changes.</p>
      )}

      {result.success && result.mode === 'full' && (
        <div className="stack gap-sm">
          {result.deltas.length === 0 && <p className="muted small">No token or native balance moves.</p>}
          {(result.deltas.length > 0 || result.approvals.length > 0) && (
            <div className="sim-ledger">
              {result.deltas.map((delta) => (
                <div key={delta.address} className="sim-row">
                  <AddressTag address={delta.address} chain={chain} label={delta.isSafe ? 'This Safe' : undefined} />
                  <span className="sim-amounts">
                    {delta.changes.map((change) => (
                      <Change key={change.token} change={change} />
                    ))}
                  </span>
                </div>
              ))}
              {result.approvals.map((approval) => (
                <div key={`${approval.token}:${approval.spender}`} className="sim-row">
                  <AddressTag address={approval.spender} chain={chain} />
                  <span className="sim-amounts">
                    <span className="sim-change">
                      <span className={approval.unlimited ? 'text-bad' : 'muted'}>
                        may spend {approval.unlimited ? 'unlimited' : <span className="mono">{tokenAmount(approval.amount, approval)}</span>}
                      </span>
                      <TokenName token={approval} />
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const SimulationCard = ({ record, chain }: { record: SafeTxRecord; chain: ChainConfig }) => {
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await simulateSafeTx(clientFor(chain), record, chain))
    } catch (cause) {
      setResult(null)
      setError(`Simulation failed: ${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }, [chain, record])

  useEffect(() => {
    void run()
  }, [record.id, chain.chainId])

  return (
    <Card
      title="If executed now"
      subtitle="Runs this exact transaction against the current chain state through your RPC. Nothing is sent."
      actions={
        <>
          {result && <Badge tone={result.success ? (result.setupChanges.length ? 'warn' : 'good') : 'bad'}>{result.success ? 'Simulated' : 'Reverts'}</Badge>}
          <Button size="sm" variant="ghost" busy={busy} onClick={() => void run()}>
            Re-run
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      {result ? <Outcome result={result} chain={chain} /> : !error && <p className="muted small">Simulating…</p>}
      {result && <p className="muted small">Simulated {timeAgo(result.at)}</p>}
    </Card>
  )
}
