import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import { SODAX_CHAINS, assertRealSafe, isDeployed, readSafe, type DeployedSafe, type SafeRecord } from '@msa/core'
import { clientFor, useChains, useCollection, useStorage } from '../state/data.tsx'
import { AddressTag, Badge, Button, Card, ChainPill, Empty, ErrorNote, Field, Modal } from '../components/ui.tsx'
import { errorMessage, formatUsd, timeAgo } from '../lib/format.ts'
import { useHiddenAmounts, useSafeWorth } from '../lib/worth.ts'
import { formatApy } from '../actions/SodaxLendForm.tsx'
import { OtherChains } from '../components/OtherChains.tsx'

const AddExistingSafe = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const storage = useStorage()
  const navigate = useNavigate()
  const { chains, byId } = useChains()
  const [chainId, setChainId] = useState<number>()
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chain = byId.get(chainId ?? chains[0]?.chainId ?? 0)

  const submit = async () => {
    if (!chain) return
    setError(null)
    if (!isAddress(address)) return setError('That is not a valid address')
    setBusy(true)
    try {
      const safeAddress = getAddress(address)
      const client = clientFor(chain)
      if (!(await isDeployed(client, safeAddress))) throw new Error(`No contract at this address on ${chain.name}`)
      await assertRealSafe(client, safeAddress, chain.chainId)
      const onchain = await readSafe(client, safeAddress)
      const record: SafeRecord = {
        id: `${chain.chainId}:${safeAddress.toLowerCase()}`,
        name: name.trim() || 'Imported Safe',
        chainId: chain.chainId,
        status: 'deployed',
        address: safeAddress,
        owners: onchain.owners,
        threshold: onchain.threshold,
        saltNonce: '',
        createdAt: new Date().toISOString(),
      }
      await storage.put('safes', record)
      await Promise.all(
        onchain.owners.map(async (owner) => {
          const id = owner.toLowerCase()
          if (!(await storage.get('owners', id))) await storage.put('owners', { id, address: owner, label: 'Unnamed signer' })
        }),
      )
      onClose()
      navigate(`/safes/${encodeURIComponent(record.id)}`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="Add an existing Safe" onClose={onClose}>
      <div className="stack gap-md">
        <Field label="Chain">
          <select value={chain?.chainId} onChange={(event) => setChainId(Number(event.target.value))}>
            {chains.map((candidate) => (
              <option key={candidate.chainId} value={candidate.chainId}>
                {candidate.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Safe address">
          <input className="mono" value={address} onChange={(event) => setAddress(event.target.value.trim())} placeholder="0x…" />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Treasury" />
        </Field>
        <ErrorNote error={error} />
        <div className="modal-foot">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Add Safe
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const safeHref = (safe: SafeRecord) =>
  safe.status === 'draft' ? `/safes/new/${encodeURIComponent(safe.id)}` : `/safes/${encodeURIComponent(safe.id)}`

const EyeIcon = ({ closed }: { closed: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    {closed && <path d="M3 3l18 18" />}
  </svg>
)

const SafeWorthRow = ({ safe, hidden }: { safe: DeployedSafe; hidden: boolean }) => {
  const { byId } = useChains()
  const worth = useSafeWorth(safe, byId.get(safe.chainId))
  if (worth === null) return null
  return (
    <div className="row between safe-worth">
      <span className="safe-worth-value mono">{worth === undefined ? '…' : hidden ? '••••••' : formatUsd(worth.usd)}</span>
      {worth && (
        <span className={worth.apy > 0 ? 'earn-apy' : 'muted small'}>{worth.apy > 0 ? `${formatApy(worth.apy)} APY` : 'Not earning'}</span>
      )}
    </div>
  )
}

const SafeCard = ({
  safe,
  siblings,
  pending,
  hidden,
  onDuplicate,
}: {
  safe: SafeRecord
  siblings: SafeRecord[]
  pending: number
  hidden: boolean
  onDuplicate(): void
}) => {
  const navigate = useNavigate()
  const { byId } = useChains()
  return (
    <div className="safe-card" onClick={() => navigate(safeHref(safe))}>
      <div className="row between">
        <div className="row gap-sm">
          <Link to={safeHref(safe)} onClick={(event) => event.stopPropagation()}>
            <h3>{safe.name}</h3>
          </Link>
          {safe.status === 'draft' && <Badge tone="warn">Draft</Badge>}
          {pending > 0 && <Badge tone="accent">{pending} pending</Badge>}
          {safe.status === 'deployed' && SODAX_CHAINS[safe.chainId]?.stocks && <Badge tone="good">Stocks</Badge>}
        </div>
        <ChainPill chain={byId.get(safe.chainId)} />
      </div>
      {safe.status === 'deployed' && <SafeWorthRow safe={safe as DeployedSafe} hidden={hidden} />}
      <div className="row between">
        {safe.address ? <AddressTag address={safe.address} /> : <span className="muted small">Not deployed yet</span>}
        <span className="threshold">
          <strong>{safe.threshold}</strong>
          <span className="muted"> of {safe.owners.length}</span>
        </span>
      </div>
      {safe.status === 'deployed' && (
        <div className="row gap-xs wrap safe-twins">
          {siblings.length > 0 && <span className="muted tiny">Same address on</span>}
          {siblings.map((sibling) => (
            <Link key={sibling.id} to={safeHref(sibling)} className="chain-chip" onClick={(event) => event.stopPropagation()}>
              <ChainPill chain={byId.get(sibling.chainId)} />
            </Link>
          ))}
          <button
            className="chain-chip is-add"
            title="Create this Safe at the same address on another chain"
            onClick={(event) => {
              event.stopPropagation()
              onDuplicate()
            }}
          >
            + Duplicate to chain
          </button>
        </div>
      )}
    </div>
  )
}

export const Home = () => {
  const { items: safes, loading } = useCollection('safes')
  const { items: txs } = useCollection('txs', { status: 'pending' })
  const { items: notes } = useCollection('notes', { entityType: 'general' })
  const { byId } = useChains()
  const [importOpen, setImportOpen] = useState(false)
  const amounts = useHiddenAmounts()
  const [deployFrom, setDeployFrom] = useState<DeployedSafe | null>(null)
  const deployChain = deployFrom ? byId.get(deployFrom.chainId) : undefined
  const pinned = notes.filter((note) => note.pinned)

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div>
          <p className="eyebrow">Your vaults</p>
          <h1>Safes</h1>
          <p className="muted">
            Built on{' '}
            <a className="link" href="https://safe.global" target="_blank" rel="noreferrer">
              Safe
            </a>{' '}
            (formerly Gnosis Safe): open source,{' '}
            <Link className="link" to="/security">
              audited contracts
            </Link>{' '}
            that have secured billions onchain since 2018.
          </p>
        </div>
        <div className="row gap-sm">
          <button
            className="icon-btn"
            onClick={amounts.toggle}
            title={amounts.hidden ? 'Show amounts' : 'Hide amounts'}
            aria-label={amounts.hidden ? 'Show amounts' : 'Hide amounts'}
          >
            <EyeIcon closed={amounts.hidden} />
          </button>
          <Button onClick={() => setImportOpen(true)}>Add existing</Button>
          <Link to="/safes/new" className="btn btn-primary btn-md">
            New Safe
          </Link>
        </div>
      </div>

      <div className="home-grid">
        <div className="stack gap-md">
          {!loading && safes.length === 0 && (
            <Card>
              <Empty
                title="No Safes yet"
                body="Create a new multisig or add one you already have."
                action={
                  <Link to="/safes/new" className="btn btn-primary btn-md">
                    Create your first Safe
                  </Link>
                }
              />
            </Card>
          )}
          {safes.map((safe) => (
            <SafeCard
              key={safe.id}
              safe={safe}
              siblings={safes.filter(
                (other) =>
                  other.id !== safe.id &&
                  other.status === 'deployed' &&
                  !!safe.address &&
                  other.address?.toLowerCase() === safe.address.toLowerCase(),
              )}
              pending={txs.filter((tx) => tx.safeId === safe.id).length}
              hidden={amounts.hidden}
              onDuplicate={() => setDeployFrom(safe as DeployedSafe)}
            />
          ))}
        </div>

        <Card
          title="Pinned notes"
          actions={
            <Link to="/notebook" className="link small">
              Notebook →
            </Link>
          }
        >
          {pinned.length === 0 ? (
            <p className="muted small">Pin notes in the notebook to see them here, e.g. “How I deposit on SODAX”.</p>
          ) : (
            <div className="stack gap-sm">
              {pinned.map((note) => (
                <Link key={note.id} to="/notebook" className="pinned-note">
                  <strong>{note.title || 'Untitled'}</strong>
                  <span className="muted small clamp">{note.body}</span>
                  <span className="muted tiny">Edited {timeAgo(note.updatedAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      <AddExistingSafe open={importOpen} onClose={() => setImportOpen(false)} />
      {deployFrom && deployChain && (
        <Modal open title={`Duplicate ${deployFrom.name} to another chain`} onClose={() => setDeployFrom(null)}>
          <OtherChains safe={deployFrom} chain={deployChain} />
        </Modal>
      )}
    </div>
  )
}
