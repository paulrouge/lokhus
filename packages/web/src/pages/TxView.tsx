import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { type Hex } from 'viem'
import {
  execTransactionData,
  SAFE_MULTISEND_CALL_ONLY,
  verifyMultiSendCallOnly,
  assertSafeTxRecord,
  assertStoredSignatures,
  safeTxRecordProblem,
  explorerLink,
  readSafe,
  recoverSafeTxSigner,
  buildSafeTx,
  safeTxHash,
  safeTxHashParts,
  type ActionContext,
  type Address,
  type ChainConfig,
  type DeployedSafe,
  type FollowUp,
  type Owner,
  type SafeRecord,
  type SafeTxRecord,
  type TxSignature,
  type WalletPlugin,
} from '@msa/core'
import { actionRegistry } from '../plugins.ts'
import {
  CallList,
  ChecksSummary,
  DetailsList,
  ExpiryBanner,
  FollowUpBadge,
  isExpired,
  useFollowUpPolling,
  useNow,
} from '../components/ActionPanels.tsx'
import { clientFor, useChains, useCollection, useDoc, useOwnerLabels, useStorage } from '../state/data.tsx'
import { describeNonces, missingNonces } from '../lib/nonces.ts'
import { useWallet } from '../state/wallet.tsx'
import { AddressTag, Avatar, Badge, Breadcrumb, Button, Card, CopyButton, Empty, ErrorNote } from '../components/ui.tsx'
import { NotesBox } from '../components/Notes.tsx'
import { SimulationCard } from '../components/SimulationCard.tsx'
import { sendAndWait, signSafeTx } from '../lib/signing.ts'
import { errorMessage, shortAddress, timeAgo } from '../lib/format.ts'

const HashRow = ({ label, value }: { label: string; value: string }) => (
  <div className="hash-row">
    <span className="muted small">{label}</span>
    <span className="mono small">{shortAddress(value)}</span>
    <CopyButton value={value} />
  </div>
)

const actionContext = (chain: ChainConfig, safe: SafeRecord): ActionContext => ({
  chain,
  safe: safe as DeployedSafe,
  client: clientFor(chain),
})

const PATIENCE_MS = 60_000

export const FollowUpView = ({
  title,
  followUp,
  busy,
  error,
  canCheck,
  onReport,
  onCheck,
  since,
}: {
  title: string
  since?: string
  followUp?: FollowUp
  busy: 'submit' | 'status' | null
  error: string | null
  canCheck: boolean
  onReport(): void
  onCheck(): void
}) => {
  const settled = followUp?.state === 'done' || followUp?.state === 'failed'
  const polling = !followUp || followUp.state === 'progress'
  const now = useNow()
  const startedAt = since ?? followUp?.at
  const patient = !settled && !!startedAt && now - Date.parse(startedAt) < PATIENCE_MS
  return (
    <Card
      title={title}
      subtitle={
        settled
          ? 'Settled. Nothing left to do.'
          : !polling
            ? 'Needs you before it can continue.'
            : 'Reported to SODAX automatically after execution. Checked every 15 seconds until it settles.'
      }
    >
      <div className="kv small">
        <span>Status</span>
        <FollowUpBadge followUp={followUp} />
        {followUp && (
          <>
            <span>Checked</span>
            <span>{timeAgo(followUp.at)}</span>
          </>
        )}
      </div>
      {followUp?.message && <p className="muted small">{followUp.message}</p>}
      {followUp?.url && (
        <a className="small" href={followUp.url} target="_blank" rel="noreferrer">
          View on SODAXScan
        </a>
      )}
      {polling && (
        <div className="progress-track" role="progressbar" aria-label="Waiting for the next check">
          <span className="progress-fill" />
        </div>
      )}
      {settled || patient ? null : (
        <>
          <ErrorNote error={error} />
          <div className="row gap-sm wrap">
            <Button size="sm" busy={busy === 'submit'} onClick={onReport}>
              {followUp ? 'Report again' : 'Report to SODAX'}
            </Button>
            {canCheck && (
              <Button size="sm" variant="ghost" busy={busy === 'status'} onClick={onCheck}>
                Check status
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

const FollowUpCard = ({ record, chain, safe }: { record: SafeTxRecord; chain: ChainConfig; safe: SafeRecord }) => {
  const storage = useStorage()
  const plugin = actionRegistry.get(record.action.pluginId)
  const [busy, setBusy] = useState<'submit' | 'status' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!plugin?.afterExecute || !record.executedTxHash) return null
  const txHash = record.executedTxHash

  const run = async (kind: 'submit' | 'status') => {
    setBusy(kind)
    setError(null)
    try {
      const context = actionContext(chain, safe)
      const next =
        kind === 'submit'
          ? await plugin.afterExecute!(record.action, txHash, context)
          : await plugin.status!(record.action, txHash, context)
      await storage.put('txs', { ...record, followUp: { ...next, at: new Date().toISOString() } })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <FollowUpView
      title={`${plugin.label} status`}
      since={record.executedAt}
      followUp={record.followUp}
      busy={busy}
      error={error}
      canCheck={!!plugin.status}
      onReport={() => void run('submit')}
      onCheck={() => void run('status')}
    />
  )
}

const useOffscreen = (target: RefObject<HTMLElement | null>) => {
  const [position, setPosition] = useState<'visible' | 'above' | 'below'>('visible')
  useEffect(() => {
    const element = target.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      setPosition(entry.isIntersecting ? 'visible' : entry.boundingClientRect.top < 0 ? 'above' : 'below')
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [target])
  return position
}

const HintFrame = ({ ready, label, children }: { ready?: boolean; label: string; children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null)
  const position = useOffscreen(ref)
  return (
    <>
      <div ref={ref} className={`signer-hint ${ready ? 'is-ready' : ''}`}>
        {children}
      </div>
      {position !== 'visible' && (
        <button
          className={`hint-beacon is-${position} ${ready ? 'is-ready' : ''}`}
          onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        >
          <span className="hint-beacon-arrow">{position === 'above' ? '↑' : '↓'}</span>
          {label}
        </button>
      )}
    </>
  )
}

export interface Signer {
  address: Address
  pluginId: string
}

const SignerHint = ({
  record,
  safe,
  expired,
  owners,
  plugins,
  connection,
  onConnect,
}: {
  record: SafeTxRecord
  safe: SafeRecord
  expired: boolean
  owners: Map<string, Owner>
  plugins: WalletPlugin[]
  connection: Signer | null
  onConnect(): void
}) => {
  if (record.status !== 'pending' || expired) return null
  const signed = new Set(record.signatures.map((signature) => signature.signer.toLowerCase()))
  const missing = safe.threshold - record.signatures.length
  const connectedAddress = connection?.address.toLowerCase()
  const connectedOwner = !!connectedAddress && safe.owners.some((owner) => owner.toLowerCase() === connectedAddress)

  if (missing <= 0) {
    return connection ? null : (
      <HintFrame ready label="Connect to execute">
        <div className="signer-hint-head">
          <span className="signer-hint-title">All {safe.threshold} signatures are in</span>
          <span className="signer-hint-reason">
            Connect any wallet to execute. It pays the gas and does not need to be an owner.
          </span>
        </div>
        <Button size="sm" variant="primary" onClick={onConnect}>
          Connect to execute
        </Button>
      </HintFrame>
    )
  }
  if (connectedOwner && !signed.has(connectedAddress!)) return null

  const waiting = safe.owners.filter((owner) => !signed.has(owner.toLowerCase()))
  const current = connectedAddress ? (owners.get(connectedAddress)?.label ?? shortAddress(connection!.address)) : null
  const reason = !connection
    ? 'No signer connected.'
    : connectedOwner
      ? `${current} has already signed.`
      : `${current} is not an owner of this Safe.`

  return (
    <HintFrame label={connection ? 'Switch signer' : 'Connect a signer'}>
      <div className="signer-hint-head">
        <span className="signer-hint-title">
          {missing} more signature{missing === 1 ? '' : 's'} needed
        </span>
        <span className="signer-hint-reason">{reason} Switch to one of these signers:</span>
      </div>
      <div className="signer-hint-list">
        {waiting.map((address) => {
          const known = owners.get(address.toLowerCase())
          const via = known?.connectedVia ?? plugins.find((plugin) => plugin.id === known?.walletPluginId)?.label
          return (
            <span key={address} className="signer-hint-chip">
              <Avatar address={address} size={18} />
              <span>{known?.label ?? shortAddress(address)}</span>
              {via && <span className="muted tiny">{via}</span>}
            </span>
          )
        })}
      </div>
      <Button size="sm" variant="primary" onClick={onConnect}>
        {connection ? 'Switch signer' : 'Connect a signer'}
      </Button>
    </HintFrame>
  )
}

export const TxView = () => {
  const { id = '', hash = '' } = useParams()
  const navigate = useNavigate()
  const storage = useStorage()
  const { byId } = useChains()
  const owners = useOwnerLabels()
  const { doc: safe } = useDoc('safes', id)
  const { doc: record, loading } = useDoc('txs', hash)
  const { connection, openConnect, plugins } = useWallet()
  const { items: safeTxs } = useCollection('txs', { safeId: id })
  const [onchainNonce, setOnchainNonce] = useState<bigint | null>(null)
  const [busy, setBusy] = useState<'sign' | 'execute' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelSigning = useRef<(() => void) | null>(null)
  const chain = record ? byId.get(record.chainId) : undefined
  useFollowUpPolling(record ? [record] : [], chain, safe)

  const [multiSendVerified, setMultiSendVerified] = useState<boolean | null>(null)
  useEffect(() => {
    if (!chain || record?.tx.operation !== 1) return
    void verifyMultiSendCallOnly(clientFor(chain)).then(setMultiSendVerified)
  }, [chain, record?.tx.operation])

  useEffect(() => {
    if (!chain || !record) return
    void readSafe(clientFor(chain), record.safeAddress).then((state) => setOnchainNonce(state.nonce))
  }, [chain, record?.safeAddress, record?.status])

  if (loading && !record) return <p className="muted">Loading…</p>
  if (!record || !safe || !chain || record.safeId !== safe.id || record.chainId !== safe.chainId || record.safeAddress.toLowerCase() !== safe.address?.toLowerCase())
    return <Empty title="Transaction not found" action={<Link to="/">Back</Link>} />

  const tampered =
    safeTxRecordProblem(record) ??
    (record.tx.operation === 1 && multiSendVerified === false
      ? `the code at ${SAFE_MULTISEND_CALL_ONLY.address} is not ${SAFE_MULTISEND_CALL_ONLY.name} ${SAFE_MULTISEND_CALL_ONLY.version}`
      : null)

  const enough = record.signatures.length >= safe.threshold

  const collectSignature = async (current: SafeTxRecord): Promise<SafeTxRecord> => {
    if (!connection) throw new Error('Connect a signer first')
    const signature = await Promise.race([
      signSafeTx(connection, chain, current),
      new Promise<never>((_, reject) => {
        cancelSigning.current = () => reject(new Error('Signing cancelled. Try again, or reconnect the signer if the wallet stays silent.'))
      }),
    ]).finally(() => {
      cancelSigning.current = null
    })
    const signer = await recoverSafeTxSigner(current.tx, current.safeAddress, chain.chainId, signature)
    if (signer.toLowerCase() !== connection.address.toLowerCase())
      throw new Error('Signature does not match the connected signer')
    const entry: TxSignature = { signer, data: signature, signedAt: new Date().toISOString() }
    const updated = { ...current, signatures: [...current.signatures.filter((existing) => existing.signer !== signer), entry] }
    await storage.put('txs', updated)
    return updated
  }

  const sign = async () => {
    setBusy('sign')
    setError(null)
    try {
      if (isExpired(record.action, Date.now())) throw new Error('This transaction has expired')
      await collectSignature(record)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const execute = async () => {
    if (!connection) return openConnect(chain)
    setBusy('execute')
    setError(null)
    try {
      if (isExpired(record.action, Date.now())) throw new Error('This transaction has expired')
      const ready = enough ? record : await collectSignature(record)
      if (ready.signatures.length < safe.threshold) throw new Error('Not enough signatures yet')
      assertSafeTxRecord(ready)
      await assertStoredSignatures(ready)
      const receipt = await sendAndWait(connection, chain, {
        to: ready.safeAddress,
        value: '0',
        data: execTransactionData(ready.tx, ready.signatures),
      })
      const executed: SafeTxRecord = {
        ...ready,
        status: 'executed',
        executedAt: new Date().toISOString(),
        executedTxHash: receipt.transactionHash as Hex,
        executedBy: connection.address,
      }
      await storage.put('txs', executed)
      const plugin = actionRegistry.get(ready.action.pluginId)
      if (plugin?.afterExecute) {
        const next = await plugin
          .afterExecute(ready.action, executed.executedTxHash!, actionContext(chain, safe))
          .catch((cause: unknown) => ({
            label: 'Report failed, press Report again',
            state: 'progress' as const,
            message: errorMessage(cause),
          }))
        await storage.put('txs', { ...executed, followUp: { ...next, at: new Date().toISOString() } })
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const nonceGap = missingNonces(record, onchainNonce, safeTxs)

  const recreate = async () => {
    if (onchainNonce === null) return
    if (record.action.expiresAt && isExpired(record.action, Date.now()))
      return setError('The quote in this transaction has expired. Delete it and create a new one instead.')
    const tx = buildSafeTx(record.action.calls, onchainNonce, chain.chainId)
    const hash = safeTxHash(tx, record.safeAddress, chain.chainId)
    await storage.put('txs', { ...record, id: hash, tx, signatures: [], createdAt: new Date().toISOString() })
    await storage.remove('txs', record.id)
    navigate(`/safes/${encodeURIComponent(safe.id)}/tx/${hash}`, { replace: true })
  }

  const remove = async () => {
    await storage.remove('txs', record.id)
    navigate(`/safes/${encodeURIComponent(safe.id)}`)
  }

  return (
    <TxScreen
      record={record}
      safe={safe}
      chain={chain}
      owners={owners}
      plugins={plugins}
      connection={connection}
      onchainNonce={onchainNonce}
      busy={busy}
      error={error}
      safeLink={`/safes/${encodeURIComponent(safe.id)}`}
      onSign={() => void sign()}
      onCancelSign={() => cancelSigning.current?.()}
      onExecute={() => void execute()}
      onDelete={() => void remove()}
      onConnect={() => openConnect(chain)}
      followUp={<FollowUpCard record={record} chain={chain} safe={safe} />}
      nonceGap={nonceGap}
      onRecreate={() => void recreate()}
      problem={tampered}
      multiSendVerified={multiSendVerified}
      notes={<NotesBox entityType="tx" entityId={record.id} placeholder="Why this transaction, context for later…" />}
    />
  )
}

export interface TxScreenProps {
  record: SafeTxRecord
  safe: SafeRecord
  chain: ChainConfig
  owners: Map<string, Owner>
  plugins: WalletPlugin[]
  connection: Signer | null
  onchainNonce: bigint | null
  busy: 'sign' | 'execute' | null
  error: string | null
  safeLink: string
  onSign(): void
  onCancelSign?(): void
  onExecute(): void
  onDelete(): void
  onConnect(): void
  followUp: ReactNode
  notes: ReactNode
  nonceGap?: bigint[]
  onRecreate?(): void
  problem?: string | null
  multiSendVerified?: boolean | null
}

export const TxScreen = ({
  record,
  safe,
  chain,
  owners,
  plugins,
  connection,
  onchainNonce,
  busy,
  error,
  safeLink,
  onSign,
  onCancelSign,
  onExecute,
  onDelete,
  onConnect,
  followUp,
  notes,
  nonceGap = [],
  onRecreate,
  problem = null,
  multiSendVerified = null,
}: TxScreenProps) => {
  const now = useNow()
  const parts = safeTxHashParts(record.tx, record.safeAddress, chain.chainId)
  const signedBy = new Set(record.signatures.map((signature) => signature.signer.toLowerCase()))
  const enough = record.signatures.length >= safe.threshold
  const isNext = onchainNonce !== null && BigInt(record.tx.nonce) === onchainNonce
  const connectedIsOwner = !!connection && safe.owners.some((owner) => owner.toLowerCase() === connection.address.toLowerCase())
  const canSign = record.status === 'pending' && !problem && connectedIsOwner && !signedBy.has(connection!.address.toLowerCase())
  const isLedger = connection?.pluginId === 'ledger'
  const missing = safe.threshold - record.signatures.length
  const expired = record.status === 'pending' && isExpired(record.action, now)
  const canSignAndExecute = canSign && missing === 1 && isNext && !expired

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div className="stack gap-xs">
          <Breadcrumb
            items={[{ label: 'Safes', to: '/' }, { label: safe.name, to: safeLink }, { label: `Transaction #${record.tx.nonce}` }]}
          />
          <h1 className="tx-title">{record.action.summary}</h1>
          <div className="row gap-sm">
            {record.status === 'pending' && (
              <Badge tone={enough ? 'good' : 'accent'}>
                {record.signatures.length} of {safe.threshold} signatures
              </Badge>
            )}
            {record.status === 'executed' && <Badge tone="good">Executed</Badge>}
            {record.status === 'replaced' && <Badge>Nonce used by another transaction</Badge>}
            {record.status === 'pending' && onchainNonce !== null && !isNext && nonceGap.length === 0 && (
              <Badge tone="warn">Waiting for #{onchainNonce.toString()} first</Badge>
            )}
            {nonceGap.length > 0 && <Badge tone="bad">Blocked: {describeNonces(nonceGap)} missing</Badge>}
          </div>
        </div>
      </div>

      {nonceGap.length > 0 && (
        <div className="nonce-gap">
          <div className="signer-hint-head">
            <span className="nonce-gap-title">This transaction can never execute as it is</span>
            <span>
              It uses nonce #{record.tx.nonce}, but the Safe is at #{onchainNonce?.toString()} and nothing is queued for{' '}
              {describeNonces(nonceGap)}. A Safe only executes nonces in order, so rebuild it at #{onchainNonce?.toString()}.
              Signatures are tied to the nonce, so everyone signs again.
            </span>
          </div>
          {onRecreate && (
            <Button variant="primary" onClick={onRecreate}>
              Recreate as #{onchainNonce?.toString()}
            </Button>
          )}
        </div>
      )}

      <ExpiryBanner action={record.action} signaturesNeeded={safe.threshold} done={record.status !== 'pending'} />

      <div className="split">
        <div className="stack gap-md">
          {record.action.details && (
            <Card title="Quote">
              <DetailsList details={record.action.details} />
            </Card>
          )}
          <Card title="Signatures" subtitle={`${safe.threshold} of ${safe.owners.length} owners must sign`}>
            <div className="stack gap-sm">
              {safe.owners.map((owner) => {
                const signature = record.signatures.find((entry) => entry.signer.toLowerCase() === owner.toLowerCase())
                const known = owners.get(owner.toLowerCase())
                const plugin = plugins.find((candidate) => candidate.id === known?.walletPluginId)
                const connected = connection?.address.toLowerCase() === owner.toLowerCase()
                return (
                  <div key={owner} className={`signer-row ${signature ? 'is-signed' : ''} ${connected ? 'is-connected' : ''}`}>
                    <Avatar address={owner} />
                    <span className="grow">
                      <strong>{known?.label ?? shortAddress(owner)}</strong>
                      <span className="muted tiny block">
                        {shortAddress(owner)}
                        {(known?.connectedVia ?? plugin?.label) ? ` · via ${known?.connectedVia ?? plugin?.label}` : ''}
                      </span>
                    </span>
                    <span className="row gap-xs wrap">
                      {connected && <Badge tone="accent">Connected</Badge>}
                      {signature ? <Badge tone="good">Signed {timeAgo(signature.signedAt)}</Badge> : <Badge>Not signed</Badge>}
                    </span>
                  </div>
                )
              })}
            </div>

            {record.status === 'pending' && (
              <div className="action-bar">
                <ErrorNote error={problem ? `Refusing this transaction: ${problem}. Delete it and create it again.` : error} />
                <SignerHint
                  record={record}
                  safe={safe}
                  expired={expired}
                  owners={owners}
                  plugins={plugins}
                  connection={connection}
                  onConnect={onConnect}
                />
                {isLedger && (canSign || enough) && (
                  <p className="hint">
                    Ledger: check that <code>to</code>, <code>operation</code> and <code>nonce</code> on your device match this
                    transaction (operation 0 is a call, 1 a batch). If it only shows hashes, check they match the hashes below.
                    Executing needs <strong>Blind signing</strong> enabled in the Ethereum app.
                  </p>
                )}
                <div className="row gap-sm wrap">
                  {expired ? null : canSignAndExecute ? (
                    <Button variant="primary" busy={busy === 'execute'} onClick={onExecute}>
                      Sign & execute
                    </Button>
                  ) : (
                    canSign && (
                      <Button variant="primary" busy={busy === 'sign'} onClick={onSign}>
                        Sign
                      </Button>
                    )
                  )}
                  {busy === 'sign' && onCancelSign && (
                    <Button variant="ghost" onClick={onCancelSign}>
                      Cancel
                    </Button>
                  )}
                  {enough && connection && !expired && !problem && (
                    <Button variant="primary" busy={busy === 'execute'} disabled={!isNext} onClick={onExecute}>
                      Execute
                    </Button>
                  )}
                  <Button variant="ghost" onClick={onDelete}>
                    Delete
                  </Button>
                </div>
              </div>
            )}

            {record.executedTxHash && (
              <div className="action-bar">
                <div className="row between wrap gap-sm">
                  {record.executedBy && (
                    <span className="muted small">
                      Executed by <AddressTag address={record.executedBy} />
                    </span>
                  )}
                  <a className="link" href={explorerLink(chain, 'tx', record.executedTxHash)} target="_blank" rel="noreferrer">
                    View execution on explorer ↗
                  </a>
                </div>
              </div>
            )}
          </Card>

          {followUp}

          <Card title="Notes">{notes}</Card>
        </div>

        <div className="stack gap-md">
          {record.status === 'pending' && !problem && <SimulationCard record={record} chain={chain} />}
          <Card title="What gets executed">
            <ChecksSummary checks={record.action.checks} />
            <CallList calls={record.action.calls} chain={chain} />
          </Card>
          <Card title="Hashes" subtitle="Compare these with your hardware wallet screen.">
            <HashRow label="Safe tx hash" value={parts.safeTxHash} />
            <HashRow label="Domain hash" value={parts.domainHash} />
            <HashRow label="Message hash" value={parts.messageHash} />
            <div className="divider" />
            <div className="kv small">
              <span>Operation</span>
              <span className="stack gap-xs">
                {record.tx.operation === 1 ? (
                  <>
                    <span>Batch (delegatecall)</span>
                    <AddressTag address={record.tx.to} chain={chain} label={SAFE_MULTISEND_CALL_ONLY.name} />
                    {multiSendVerified === null ? (
                      <Badge>Checking contract code…</Badge>
                    ) : multiSendVerified ? (
                      <Badge tone="good">
                        Verified {SAFE_MULTISEND_CALL_ONLY.name} {SAFE_MULTISEND_CALL_ONLY.version}
                      </Badge>
                    ) : (
                      <Badge tone="bad">Not the Safe contract</Badge>
                    )}
                  </>
                ) : (
                  'Call'
                )}
              </span>
              <span>Nonce</span>
              <span className="mono">{record.tx.nonce}</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
