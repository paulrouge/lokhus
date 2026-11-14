import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getAddress, isAddress, type Address } from 'viem'
import { creationFromTx, isDeployed, predictSafeAddress, safeDeploymentTx, validateSetup, waitForDeployment, type SafeRecord } from '@msa/core'
import { clientFor, useChains, useCollection, useDoc, useStorage } from '../state/data.tsx'
import { useWallet } from '../state/wallet.tsx'
import { AddressTag, Avatar, Badge, Breadcrumb, Button, ErrorNote, Field } from '../components/ui.tsx'
import { NotesBox } from '../components/Notes.tsx'
import { sendAndWait } from '../lib/signing.ts'
import { errorMessage, shortAddress } from '../lib/format.ts'

const SAVE_DELAY_MS = 500
const PREDICT_DELAY_MS = 400

const SetupStep = ({ index, title, hint, children }: { index: number; title: string; hint?: string; children: ReactNode }) => (
  <section className="setup-step">
    <header>
      <span className="setup-index">{index}</span>
      <div>
        <h2>{title}</h2>
        {hint && <p className="muted small">{hint}</p>}
      </div>
    </header>
    <div className="stack gap-md">{children}</div>
  </section>
)

const PolicyVerdict = ({ threshold, owners }: { threshold: number; owners: number }) => {
  if (threshold === 0) return <p className="verdict is-warn">Not picked yet.</p>
  const sentence = (
    <p className="verdict-sentence">
      Any <strong>{threshold}</strong> of these <strong>{owners}</strong> owners must sign before funds can move.
    </p>
  )
  if (owners === 1) return <div className="verdict is-warn">{sentence}Only one owner: this is not a multisig. One lost or leaked key decides everything.</div>
  if (threshold === 1)
    return <div className="verdict is-bad">{sentence}Any single owner can move all funds alone. One stolen or leaked key empties this Safe.</div>
  if (threshold === owners)
    return <div className="verdict is-warn">{sentence}Every owner must sign. Lose one key and the Safe is locked forever.</div>
  return (
    <div className="verdict is-good">
      {sentence}A thief needs {threshold} keys; you can lose {owners - threshold} and still sign.
    </div>
  )
}

const newDraft = (chainId: number): SafeRecord => ({
  id: crypto.randomUUID(),
  name: '',
  chainId,
  status: 'draft',
  owners: [],
  threshold: 0,
  saltNonce: String(Date.now()),
  createdAt: new Date().toISOString(),
})

export const SafeSetup = () => {
  const { id } = useParams()
  const navigate = useNavigate()
  const storage = useStorage()
  const { chains, byId } = useChains()
  const { items: knownOwners } = useCollection('owners')
  const { doc, loading } = useDoc('safes', id)
  const { connection, openConnect } = useWallet()

  const [draft, setDraft] = useState<SafeRecord | null>(null)
  const [predicted, setPredicted] = useState<{ address: Address; deployed: boolean } | null>(null)
  const [predicting, setPredicting] = useState(false)
  const [newOwner, setNewOwner] = useState({ address: '', label: '' })
  const [error, setError] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (draft) return
    if (id && doc) setDraft(doc)
    if (!id && chains[0]) setDraft(newDraft(chains[0].chainId))
  }, [id, doc, chains, draft])

  useEffect(() => {
    if (doc?.status === 'deployed') navigate(`/safes/${encodeURIComponent(doc.id)}`, { replace: true })
  }, [doc, navigate])

  const chain = draft ? byId.get(draft.chainId) : undefined
  const setupKey = draft ? `${draft.owners.join(',')}|${draft.threshold}|${draft.saltNonce}` : ''
  const setup = useMemo(
    () => (draft ? { owners: draft.owners, threshold: draft.threshold, saltNonce: draft.saltNonce } : null),
    [setupKey],
  )
  const setupError = !draft ? null : draft.threshold === 0 ? 'Pick how many signatures are needed' : setup ? validateSetup(setup) : null

  useEffect(() => setConfirmed(false), [setupKey, draft?.chainId])

  useEffect(() => {
    setPredicted(null)
    if (!chain || !setup || setupError) return
    let cancelled = false
    setPredicting(true)
    const timer = setTimeout(async () => {
      try {
        const address = await predictSafeAddress(chain, setup)
        const deployed = await isDeployed(clientFor(chain), address)
        if (!cancelled) setPredicted({ address, deployed })
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause))
      } finally {
        if (!cancelled) setPredicting(false)
      }
    }, PREDICT_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [chain, setup, setupError])

  const update = (patch: Partial<SafeRecord>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void storage.put('safes', next).then(() => {
        if (!id) navigate(`/safes/new/${encodeURIComponent(next.id)}`, { replace: true })
      })
    }, SAVE_DELAY_MS)
  }

  const toggleOwner = (address: Address) => {
    if (!draft) return
    const has = draft.owners.some((owner) => owner.toLowerCase() === address.toLowerCase())
    const owners = has ? draft.owners.filter((owner) => owner.toLowerCase() !== address.toLowerCase()) : [...draft.owners, address]
    update({ owners, threshold: Math.min(draft.threshold, owners.length) })
  }

  const addOwner = async () => {
    setError(null)
    if (!isAddress(newOwner.address)) return setError('That owner address is not valid')
    const address = getAddress(newOwner.address)
    const existing = await storage.get('owners', address.toLowerCase())
    await storage.put('owners', {
      ...existing,
      id: address.toLowerCase(),
      address,
      label: newOwner.label.trim() || existing?.label || 'Unnamed signer',
    })
    setNewOwner({ address: '', label: '' })
    if (!draft?.owners.some((owner) => owner.toLowerCase() === address.toLowerCase())) toggleOwner(address)
  }

  const deploy = async () => {
    if (!draft || !chain || !setup || !predicted || !confirmed) return
    if (!connection) return openConnect(chain)
    setError(null)
    setDeploying(true)
    try {
      const deploymentTx = await safeDeploymentTx(chain, setup)
      const receipt = predicted.deployed ? null : await sendAndWait(connection, chain, deploymentTx)
      await waitForDeployment(clientFor(chain), predicted.address)
      const deployed: SafeRecord = {
        ...draft,
        name: draft.name.trim() || 'My Safe',
        status: 'deployed',
        address: predicted.address,
        deploySetup: setup,
        creation: { ...creationFromTx(deploymentTx), txHash: receipt?.transactionHash },
        deployTxHash: receipt?.transactionHash,
        deployBlock: receipt?.blockNumber.toString(),
      }
      clearTimeout(saveTimer.current)
      await storage.put('safes', deployed)
      navigate(`/safes/${encodeURIComponent(deployed.id)}`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDeploying(false)
    }
  }

  const discard = async () => {
    if (!draft) return
    clearTimeout(saveTimer.current)
    await storage.remove('safes', draft.id)
    navigate('/')
  }

  if (!draft || (id && loading && !doc)) return <p className="muted">Loading…</p>

  const selected = new Set(draft.owners.map((owner) => owner.toLowerCase()))
  const ownerCount = draft.owners.length
  const threshold = draft.threshold
  const majority = Math.floor(ownerCount / 2) + 1
  const policy = `${threshold} of ${ownerCount}`
  const ready = !setupError && !!predicted

  return (
    <div className="setup-flow">
      <div className="hero">
        <div>
          <Breadcrumb items={[{ label: 'Safes', to: '/' }, { label: 'New Safe' }]}>
            {id && <Badge tone="warn">Draft · autosaved</Badge>}
          </Breadcrumb>
          <h1>{draft.name || 'Untitled Safe'}</h1>
        </div>
        {id && (
          <Button variant="ghost" onClick={() => void discard()}>
            Discard draft
          </Button>
        )}
      </div>

      <SetupStep index={1} title="Name and chain">
        <div className="grid-2">
          <Field label="Name">
            <input value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="Treasury" />
          </Field>
          <Field label="Chain">
            <select value={draft.chainId} onChange={(event) => update({ chainId: Number(event.target.value) })}>
              {chains.map((candidate) => (
                <option key={candidate.chainId} value={candidate.chainId}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </SetupStep>

      <SetupStep index={2} title={`Owners: ${ownerCount} selected`} hint="Click to select. Selected owners are dark.">
        <div className="owner-picker">
          {knownOwners.map((owner) => (
            <button key={owner.id} className={`owner-chip ${selected.has(owner.id) ? 'is-on' : ''}`} onClick={() => toggleOwner(owner.address)}>
              <Avatar address={owner.address} size={20} />
              <span>{owner.label}</span>
              <span className="mono muted tiny">{shortAddress(owner.address)}</span>
            </button>
          ))}
          {knownOwners.length === 0 && <p className="muted small">Connect a signer (top right) and it shows up here, or add an address below.</p>}
        </div>
        <div className="add-owner">
          <input
            className="mono"
            placeholder="0x… owner address"
            value={newOwner.address}
            onChange={(event) => setNewOwner({ ...newOwner, address: event.target.value.trim() })}
          />
          <input placeholder="Label, e.g. Tangem" value={newOwner.label} onChange={(event) => setNewOwner({ ...newOwner, label: event.target.value })} />
          <Button onClick={() => void addOwner()} disabled={!newOwner.address}>
            Add
          </Button>
        </div>
      </SetupStep>

      <SetupStep index={3} title="How many owners must sign each transaction?" hint="There is no default. You have to pick.">
        {ownerCount === 0 ? (
          <p className="muted">Select owners first.</p>
        ) : (
          <>
            <div className="threshold-picker big">
              {draft.owners.map((_, index) => (
                <button
                  key={index}
                  className={`threshold-option ${threshold === index + 1 ? 'is-on' : ''}`}
                  onClick={() => update({ threshold: index + 1 })}
                >
                  <span>{index + 1}</span>
                  {index + 1 === majority && ownerCount > 1 && <span className="threshold-tag">recommended</span>}
                </button>
              ))}
            </div>
            <PolicyVerdict threshold={threshold} owners={ownerCount} />
          </>
        )}
      </SetupStep>

      <SetupStep index={4} title="Check and deploy">
        <div className="setup-summary">
          <span>Chain</span>
          <strong>{chain?.name}</strong>
          <span>Owners</span>
          <div className="stack gap-xs">
            {draft.owners.map((address) => (
              <AddressTag key={address} address={address} />
            ))}
            {ownerCount === 0 && <span className="muted">None yet</span>}
          </div>
          <span>Signatures needed</span>
          <strong className={`setup-policy ${threshold === 1 && ownerCount > 1 ? 'is-bad' : ''}`}>{threshold ? policy : 'not picked'}</strong>
          <span>Safe address</span>
          <span>
            {setupError ? (
              <span className="muted small">{setupError}</span>
            ) : predicting || !predicted ? (
              <span className="muted small">Calculating…</span>
            ) : (
              <AddressTag address={predicted.address} chain={chain} />
            )}
          </span>
        </div>
        {predicted?.deployed && <p className="hint-good">This Safe already exists onchain. Saving it won’t cost gas.</p>}
        <label className={`setup-confirm ${ready ? '' : 'is-disabled'}`}>
          <input type="checkbox" disabled={!ready} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>
            I checked it: {threshold ? <strong>any {threshold} of these {ownerCount} owners</strong> : 'the owners'} must sign every
            transaction. This cannot be changed without a Safe transaction later.
          </span>
        </label>
        <ErrorNote error={error} />
        <Button variant="primary" className="full" busy={deploying} disabled={!ready || !confirmed} onClick={() => void deploy()}>
          {!ready
            ? setupError ?? 'Calculating…'
            : predicted?.deployed
              ? `Save ${policy} Safe`
              : connection
                ? `Deploy ${policy} Safe on ${chain?.name}`
                : 'Connect a signer to deploy'}
        </Button>
        <p className="muted tiny">Deploying is one transaction paid by the connected wallet. Any wallet can pay; it doesn’t need to be an owner.</p>
      </SetupStep>

      <SetupStep index={5} title="Notes" hint="Optional.">
        {id ? (
          <NotesBox entityType="safe" entityId={draft.id} placeholder="Why this Safe exists, who holds which key…" />
        ) : (
          <p className="muted small">Notes unlock once the draft is saved. Give it a name or pick owners first.</p>
        )}
      </SetupStep>
    </div>
  )
}
