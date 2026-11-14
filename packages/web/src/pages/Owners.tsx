import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import type { Owner } from '@msa/core'
import { useCollection, useStorage } from '../state/data.tsx'
import { useWallet } from '../state/wallet.tsx'
import { AddressTag, Badge, Button, Card, Empty, ErrorNote, Modal, TrashIcon } from '../components/ui.tsx'
import { NotesBox } from '../components/Notes.tsx'
import { shortAddress, timeAgo } from '../lib/format.ts'

const RemoveOwnerModal = ({
  owner,
  safeNames,
  open,
  onClose,
}: {
  owner: Owner
  safeNames: string[]
  open: boolean
  onClose(): void
}) => {
  const storage = useStorage()
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    try {
      await storage.remove('notes', `owner:${owner.id}`)
      await storage.remove('owners', owner.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="Remove signer?" onClose={onClose}>
      <div className="stack gap-sm">
        <p className="remove-target">
          <strong>{owner.label}</strong> <span className="mono muted">{shortAddress(owner.address)}</span>
        </p>
        <p className="muted small">Its label, backup checkmark and notes are deleted from Lokhus. Nothing changes onchain.</p>
        {safeNames.length > 0 && (
          <div className="warning-box small">
            Still an owner of <strong>{safeNames.join(', ')}</strong>. It keeps signing rights there until you remove it from the Safe
            itself; here it will only lose its name.
          </div>
        )}
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>
          Remove signer
        </Button>
      </div>
    </Modal>
  )
}

const OwnerCard = ({ owner, safeNames }: { owner: Owner; safeNames: string[] }) => {
  const storage = useStorage()
  const { plugins, connection } = useWallet()
  const [label, setLabel] = useState(owner.label)
  const plugin = plugins.find((candidate) => candidate.id === owner.walletPluginId)
  const isConnected = connection?.address.toLowerCase() === owner.id

  const [confirming, setConfirming] = useState(false)

  return (
    <Card className="owner-card">
      <div className="owner-head">
        <div className="owner-name">
          <input
            className="title-input small-title"
            value={label}
            placeholder="Name this signer"
            title="Click to rename"
            onChange={(event) => setLabel(event.target.value)}
            onBlur={() => label.trim() && label !== owner.label && void storage.put('owners', { ...owner, label: label.trim() })}
          />
          <span className="owner-via">{owner.connectedVia ?? plugin?.label ?? 'Added by address'}</span>
        </div>
        <button className="icon-btn icon-btn-danger" onClick={() => setConfirming(true)} aria-label="Remove signer" title="Remove signer">
          <TrashIcon />
        </button>
      </div>
      {(isConnected || !owner.recoveryStoredAt) && (
        <div className="row wrap gap-xs">
          {isConnected && <Badge tone="good">Connected</Badge>}
          {!owner.recoveryStoredAt && <Badge tone="warn">No backup</Badge>}
        </div>
      )}
      <AddressTag address={owner.address} label="" full />
      <div className="kv small">
        <span>Last connected</span>
        <span>{timeAgo(owner.lastConnectedAt)}</span>
        <span>Owner of</span>
        <span>{safeNames.length ? safeNames.join(', ') : '—'}</span>
      </div>
      <div className={`recovery-check ${owner.recoveryStoredAt ? 'is-done' : ''}`}>
        <label className="row gap-sm">
          <input
            type="checkbox"
            checked={!!owner.recoveryStoredAt}
            onChange={(event) =>
              void storage.put('owners', { ...owner, recoveryStoredAt: event.target.checked ? new Date().toISOString() : undefined })
            }
          />
          <span>
            Recovery stored safely
            {owner.recoveryStoredAt && <span className="muted"> · confirmed {timeAgo(owner.recoveryStoredAt)}</span>}
          </span>
        </label>
        <a className="small" href="/best-practice?tab=backups" target="_blank" rel="noreferrer">
          How ↗
        </a>
      </div>
      <RemoveOwnerModal owner={owner} safeNames={safeNames} open={confirming} onClose={() => setConfirming(false)} />
      <NotesBox entityType="owner" entityId={owner.id} placeholder="Where this key lives, backup cards, access code hints (never the code itself)…" />
    </Card>
  )
}

export const Owners = () => {
  const storage = useStorage()
  const { items: owners, loading } = useCollection('owners')
  const { items: safes } = useCollection('safes')
  const { openConnect, connection, plugins } = useWallet()
  const [address, setAddress] = useState('')
  const [connectedLabel, setConnectedLabel] = useState('')
  const unsaved = connection && !owners.some((owner) => owner.id === connection.address.toLowerCase()) ? connection : null

  const saveConnected = async () => {
    if (!unsaved) return
    const plugin = plugins.find((candidate) => candidate.id === unsaved.pluginId)
    await storage.put('owners', {
      id: unsaved.address.toLowerCase(),
      address: unsaved.address,
      label: connectedLabel.trim() || `${unsaved.via ?? plugin?.label ?? 'Wallet'} ${shortAddress(unsaved.address)}`,
      walletPluginId: unsaved.pluginId,
      connectedVia: unsaved.via ? `${plugin?.label ?? ''} · ${unsaved.via}` : plugin?.label,
      lastConnectedAt: new Date().toISOString(),
    })
    setConnectedLabel('')
  }
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    setError(null)
    if (!isAddress(address)) return setError('That is not a valid address')
    const checksummed = getAddress(address)
    await storage.put('owners', { id: checksummed.toLowerCase(), address: checksummed, label: label.trim() || 'Unnamed signer' })
    setAddress('')
    setLabel('')
  }

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div>
          <p className="eyebrow">Keys you control</p>
          <h1>Signers</h1>
        </div>
        <Button variant="primary" onClick={() => openConnect()}>
          Connect a signer
        </Button>
      </div>

      {unsaved && (
        <Card title="Connected, not saved" subtitle="Connected wallets are only saved when you choose to, or when they own one of your Safes.">
          <div className="add-owner">
            <span className="mono small">{shortAddress(unsaved.address)}</span>
            <input placeholder="Label, e.g. Ledger 2" value={connectedLabel} onChange={(event) => setConnectedLabel(event.target.value)} />
            <Button variant="primary" onClick={() => void saveConnected()}>
              Save as signer
            </Button>
          </div>
        </Card>
      )}

      <Card title="Add by address" subtitle="For keys you can’t connect right now.">
        <div className="add-owner">
          <input className="mono" placeholder="0x…" value={address} onChange={(event) => setAddress(event.target.value.trim())} />
          <input placeholder="Label" value={label} onChange={(event) => setLabel(event.target.value)} />
          <Button onClick={() => void add()} disabled={!address}>
            Add
          </Button>
        </div>
        <ErrorNote error={error} />
      </Card>

      {!loading && owners.length === 0 && (
        <Card>
          <Empty title="No signers yet" body="Save a connected wallet or add one by address. Wallets that own one of your Safes are saved automatically." />
        </Card>
      )}

      <div className="owner-grid">
        {owners.map((owner) => (
          <OwnerCard
            key={owner.id}
            owner={owner}
            safeNames={safes.filter((safe) => safe.owners.some((address) => address.toLowerCase() === owner.id)).map((safe) => safe.name)}
          />
        ))}
      </div>
    </div>
  )
}
