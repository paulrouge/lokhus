import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  buildSafeTx,
  readSafe,
  recoverSafeTxSigner,
  safeTxHash,
  type ActionContext,
  type ActionDetail,
  type ActionField,
  type BuiltAction,
  type DeployedSafe,
  type SafeTxRecord,
} from '@msa/core'
import { clientFor, useChains, useCollection, useDoc, useStorage } from '../state/data.tsx'
import { useWallet } from '../state/wallet.tsx'
import { actionRegistry } from '../plugins.ts'
import { actionForms } from '../actions/index.ts'
import { ActionPicker } from '../components/ActionPicker.tsx'
import { AddressListInput, splitAddresses } from '../components/AddressListInput.tsx'
import { Breadcrumb, Button, Card, Empty, ErrorNote, Field } from '../components/ui.tsx'
import { signSafeTx } from '../lib/signing.ts'
import { CallList, ChecksSummary, DetailsList, ExpiryBanner, isExpired } from '../components/ActionPanels.tsx'
import { errorMessage, shortAddress } from '../lib/format.ts'

const ActionInput = ({
  field,
  value,
  onChange,
  context,
}: {
  field: ActionField
  value: string
  onChange(value: string): void
  context: ActionContext
}) => {
  const { items: owners } = useCollection('owners')
  if (field.type === 'token') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose a token</option>
        {context.chain.tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {token.symbol} · {shortAddress(token.address)}
          </option>
        ))}
      </select>
    )
  }
  if (field.type === 'select') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose…</option>
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.type === 'textarea') {
    return <textarea value={value} rows={4} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} />
  }
  if (field.type === 'addresses') {
    return (
      <AddressListInput
        value={splitAddresses(value)}
        onChange={(list) => onChange(list.join(','))}
        suggestions={context.safe.owners.map((address) => ({ address, label: 'Current owner' }))}
      />
    )
  }
  if (field.type === 'address') {
    return (
      <>
        <input
          className="mono"
          list={`list-${field.name}`}
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
          placeholder={field.placeholder}
        />
        <datalist id={`list-${field.name}`}>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.address}>
              {owner.label}
            </option>
          ))}
        </datalist>
      </>
    )
  }
  return (
    <input
      className={field.type === 'amount' ? 'mono' : undefined}
      inputMode={field.type === 'amount' ? 'decimal' : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder}
    />
  )
}

export const TxNew = () => {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const storage = useStorage()
  const { byId } = useChains()
  const { doc: safe } = useDoc('safes', id)
  const { items: txs } = useCollection('txs', { safeId: id })
  const { connection, openConnect } = useWallet()
  const chain = safe ? byId.get(safe.chainId) : undefined

  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const pluginId = searchParams.get('action') ?? undefined
  const pickedHere = (location.state as { picked?: boolean } | null)?.picked === true
  const chooseAction = (actionId: string) => setSearchParams({ action: actionId }, { state: { picked: true } })
  const changeAction = () => (pickedHere ? navigate(-1) : setSearchParams({}, { replace: true }))
  const [input, setInput] = useState<Record<string, string>>({})
  const [built, setBuilt] = useState<BuiltAction | null>(null)
  const [nonce, setNonce] = useState<string>('')
  const [onchainNonce, setOnchainNonce] = useState<bigint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    details: ActionDetail[] | null
    error?: string
    loading: boolean
  }>({ details: null, loading: false })

  const context = useMemo<ActionContext | null>(
    () => (safe?.address && chain ? { chain, safe: safe as DeployedSafe, client: clientFor(chain) } : null),
    [safe, chain],
  )
  const actions = chain ? actionRegistry.list().filter((action) => action.supports(chain)) : []
  const plugin = pluginId ? actionRegistry.get(pluginId) : undefined

  useEffect(() => {
    if (!context) return
    void readSafe(context.client, context.safe.address).then((state) => setOnchainNonce(state.nonce))
  }, [context])

  useEffect(() => {
    if (onchainNonce === null) return
    const queued = txs
      .filter((tx) => tx.status === 'pending' && !isExpired(tx.action, Date.now()))
      .map((tx) => BigInt(tx.tx.nonce))
    const next = queued.reduce((max, value) => (value >= max ? value + 1n : max), onchainNonce)
    setNonce(next.toString())
  }, [onchainNonce, txs])

  useEffect(() => {
    setBuilt(null)
    setError(null)
  }, [pluginId, input])

  const [queueAcknowledged, setQueueAcknowledged] = useState(false)
  const waiting = txs
    .filter((tx) => tx.status === 'pending' && !isExpired(tx.action, Date.now()))
    .sort((a, b) => Number(BigInt(a.tx.nonce) - BigInt(b.tx.nonce)))
  const replacing = waiting.find((tx) => tx.tx.nonce === nonce)
  const needsAcknowledgement = waiting.length > 0 && !replacing && !queueAcknowledged

  useEffect(() => {
    const previewer = pluginId ? actionRegistry.get(pluginId)?.preview : undefined
    if (!previewer || !context) return setPreview({ details: null, loading: false })
    let cancelled = false
    setPreview((current) => ({ ...current, loading: true }))
    const timer = setTimeout(() => {
      previewer(input, context)
        .then((details) => !cancelled && setPreview({ details, loading: false }))
        .catch(
          (cause) =>
            !cancelled &&
            setPreview({
              details: null,
              loading: false,
              error: errorMessage(cause),
            }),
        )
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pluginId, input, context])

  if (!safe || !context || !chain) return <Empty title="Safe not found" action={<Link to="/">Back</Link>} />

  const review = async () => {
    if (!plugin) return
    setError(null)
    try {
      setBuilt(await plugin.build(input, context))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const create = async (sign: boolean) => {
    if (!plugin || !built || !safe.address) return
    setBusy(true)
    setError(null)
    try {
      if (built.expiresAt && isExpired({ ...built, pluginId: plugin.id, input }, Date.now()))
        throw new Error('The quote expired. Press Review again for a fresh one.')
      const tx = buildSafeTx(built.calls, BigInt(nonce), chain.chainId)
      const hash = safeTxHash(tx, safe.address, chain.chainId)
      const existing = await storage.get('txs', hash)
      const record: SafeTxRecord = existing ?? {
        id: hash,
        safeId: safe.id,
        chainId: chain.chainId,
        safeAddress: safe.address,
        tx,
        action: {
          pluginId: plugin.id,
          input,
          summary: built.summary,
          calls: built.calls,
          checks: built.checks,
          details: built.details,
          expiresAt: built.expiresAt,
          meta: built.meta,
        },
        signatures: [],
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      await storage.put('txs', record)
      if (sign && connection) {
        const signature = await signSafeTx(connection, chain, record)
        const signer = await recoverSafeTxSigner(record.tx, record.safeAddress, chain.chainId, signature)
        if (signer.toLowerCase() !== connection.address.toLowerCase())
          throw new Error('Signature does not match the connected signer')
        await storage.put('txs', {
          ...record,
          signatures: [{ signer, data: signature, signedAt: new Date().toISOString() }],
        })
      }
      navigate(`/safes/${encodeURIComponent(safe.id)}/tx/${hash}`, { replace: true })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const isOwner = !!connection && safe.owners.some((owner) => owner.toLowerCase() === connection.address.toLowerCase())

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div>
          <Breadcrumb
            items={[
              { label: 'Safes', to: '/' },
              { label: safe.name, to: `/safes/${encodeURIComponent(safe.id)}` },
              { label: 'New transaction', to: `/safes/${encodeURIComponent(safe.id)}/new` },
              ...(plugin ? [{ label: plugin.label }] : []),
            ]}
          />
          <h1>{plugin?.label ?? 'What do you want to do?'}</h1>
        </div>
      </div>

      {waiting.length > 0 && (
        <div className="queue-warning">
          <div className="signer-hint-head">
            <span className="queue-warning-title">
              {waiting.length} transaction{waiting.length === 1 ? ' is' : 's are'} already waiting for signatures
            </span>
            <span>
              Meant to sign one of these? Open it and switch signer there. A new transaction is queued after them and only
              executes once they are done.
            </span>
          </div>
          <div className="stack gap-xs">
            {waiting.map((tx) => (
              <Link key={tx.id} to={`/safes/${encodeURIComponent(safe.id)}/tx/${tx.id}`} className="queue-warning-row">
                <span className="tx-nonce">#{tx.tx.nonce}</span>
                <span className="grow">{tx.action.summary}</span>
                <span className="muted small">
                  {tx.signatures.length}/{safe.threshold} signed
                </span>
                <span className="link small">Open to sign →</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!plugin ? (
        <ActionPicker actions={actions} onPick={chooseAction} />
      ) : (
        <div className="split">
          <Card
            title={plugin && actionForms[plugin.id] ? undefined : 'Details'}
            actions={
              <Button variant="ghost" size="sm" onClick={changeAction}>
                Change action
              </Button>
            }
          >
            <div className="stack gap-md">
              {actionForms[plugin.id] ? (
                (() => {
                  const CustomForm = actionForms[plugin.id]!
                  return <CustomForm input={input} onChange={setInput} context={context} />
                })()
              ) : (
                <>
                  {plugin.fields(context).map((field) => (
                    <Field key={field.name} label={field.label} hint={field.help}>
                      <ActionInput
                        field={field}
                        context={context}
                        value={input[field.name] ?? ''}
                        onChange={(value) =>
                          setInput((previous) => ({
                            ...previous,
                            [field.name]: value,
                          }))
                        }
                      />
                    </Field>
                  ))}
                  {plugin.preview && (
                    <div className="preview">
                      <span className="muted tiny">
                        Live estimate, refreshes as you type. Review locks the quote and starts the clock.
                      </span>
                      {preview.details ? (
                        <DetailsList details={preview.details} />
                      ) : (
                        <span className="muted small">
                          {preview.loading
                            ? 'Fetching quote…'
                            : (preview.error ?? 'Pick a pair and an amount to see what you get.')}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
              <Field label="Nonce" hint="Defaults to the next free slot. Reuse a queued nonce to replace that transaction.">
                <input className="mono" value={nonce} onChange={(event) => setNonce(event.target.value.replace(/\D/g, ''))} />
              </Field>
              <Button variant="primary" onClick={() => void review()}>
                Review
              </Button>
            </div>
          </Card>

          <Card title="Review" className="review-card">
            {!built ? (
              <p className="muted small">Fill in the details and press Review to see exactly what will be signed.</p>
            ) : (
              <div className="stack gap-md">
                <p className="summary">{built.summary}</p>
                {built.details && <DetailsList details={built.details} />}
                <ExpiryBanner
                  action={{
                    pluginId: plugin.id,
                    input,
                    summary: built.summary,
                    calls: built.calls,
                    expiresAt: built.expiresAt,
                  }}
                  signaturesNeeded={safe.threshold}
                />
                <ChecksSummary checks={built.checks} />
                <CallList calls={built.calls} chain={chain} />
                <ErrorNote error={error} />
                {replacing ? (
                  <p className="hint">
                    Nonce #{nonce} is already used by “{replacing.action.summary}”. Whichever executes first wins; the other
                    becomes void.
                  </p>
                ) : (
                  waiting.length > 0 && (
                    <label className="queue-ack">
                      <input
                        type="checkbox"
                        checked={queueAcknowledged}
                        onChange={(event) => setQueueAcknowledged(event.target.checked)}
                      />
                      <span>
                        I want a new transaction <strong>#{nonce}</strong>, queued after{' '}
                        {waiting.map((tx) => `#${tx.tx.nonce}`).join(', ')}. I am not trying to sign one of those.
                      </span>
                    </label>
                  )
                )}
                <div className="row gap-sm wrap">
                  {isOwner ? (
                    <Button variant="primary" busy={busy} disabled={needsAcknowledgement} onClick={() => void create(true)}>
                      Create & sign
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => openConnect(chain)}>
                      Connect an owner to sign
                    </Button>
                  )}
                  <Button busy={busy} disabled={needsAcknowledgement} onClick={() => void create(false)}>
                    Create without signing
                  </Button>
                </div>
              </div>
            )}
            {!built && <ErrorNote error={error} />}
          </Card>
        </div>
      )}
    </div>
  )
}
