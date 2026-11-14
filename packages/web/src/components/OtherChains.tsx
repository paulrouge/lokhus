import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAddress } from 'viem'
import {
  assertRealSafe,
  checkCreationOn,
  creationOwners,
  creationTx,
  isDeployed,
  readBalances,
  readSafe,
  resolveCreation,
  waitForDeployment,
  type Address,
  type Balance,
  type ChainConfig,
  type DeployedSafe,
  type Owner,
  type SafeCreation,
  type SafeRecord,
} from '@msa/core'
import { clientFor, useChains, useCollection, useStorage } from '../state/data.tsx'
import { useWallet } from '../state/wallet.tsx'
import { Avatar, Badge, Button, Card, ChainPill, ErrorNote } from './ui.tsx'
import { sendAndWait, signMessageWith } from '../lib/signing.ts'
import { errorMessage, formatAmount, shortAddress, timeAgo } from '../lib/format.ts'

type CreationState = { creation: SafeCreation } | { error: string }

interface ChainStatus {
  chain: ChainConfig
  deployed: boolean
  deployable: boolean
  blocked?: string
  waiting: Balance[]
  record?: SafeRecord
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const funds = (balances: Balance[]) => balances.filter((balance) => balance.amount > 0n)

const fundsText = (balances: Balance[]) => balances.map((balance) => `${formatAmount(balance.amount, balance.decimals)} ${balance.symbol}`).join(', ')

export const OtherChainsCard = ({ safe, chain }: { safe: DeployedSafe; chain: ChainConfig }) => {
  const { chains } = useChains()
  if (!chains.some((candidate) => candidate.chainId !== chain.chainId)) return null
  return (
    <Card title="Other chains" subtitle="The same address on your other chains. Funds sent there are only reachable once the Safe exists there.">
      <OtherChains safe={safe} chain={chain} />
    </Card>
  )
}

export const OtherChains = ({ safe, chain }: { safe: DeployedSafe; chain: ChainConfig }) => {
  const storage = useStorage()
  const { chains } = useChains()
  const { items: safes } = useCollection('safes')
  const [found, setFound] = useState<CreationState | undefined>(undefined)
  const [statuses, setStatuses] = useState<ChainStatus[] | null>(null)
  const [target, setTarget] = useState<ChainConfig | null>(null)
  const others = chains.filter((candidate) => candidate.chainId !== chain.chainId)

  useEffect(() => {
    let cancelled = false
    void resolveCreation(clientFor(chain), chain, safe)
      .then((creation) => {
        if (cancelled) return
        setFound({ creation })
        if (!safe.creation) void storage.put('safes', { ...safe, creation })
      })
      .catch((cause) => !cancelled && setFound({ error: errorMessage(cause) }))
    return () => {
      cancelled = true
    }
  }, [safe.id, safe.address, chain.chainId])

  useEffect(() => {
    if (found === undefined) return
    const creation = 'creation' in found ? found.creation : null
    let cancelled = false
    void Promise.all(
      others.map(async (other): Promise<ChainStatus> => {
        const client = clientFor(other)
        const [deployed, balances] = await Promise.all([
          isDeployed(client, safe.address).catch(() => false),
          readBalances(client, other, safe.address).catch(() => []),
        ])
        const waiting = funds(balances)
        if (deployed) return { chain: other, deployed, deployable: false, waiting }
        if (!creation) return { chain: other, deployed, deployable: false, waiting, blocked: 'Creation unknown' }
        const blocked = await checkCreationOn(client, other.chainId, creation, safe.address)
          .then(() => undefined)
          .catch((cause) => errorMessage(cause))
        return { chain: other, deployed, deployable: !blocked, waiting, blocked }
      }),
    ).then((result) => !cancelled && setStatuses(result))
    return () => {
      cancelled = true
    }
  }, [found, safe.address, others.map((other) => other.chainId).join()])

  const withRecords = statuses?.map((status) => ({
    ...status,
    record: safes.find((candidate) => candidate.chainId === status.chain.chainId && candidate.address && sameAddress(candidate.address, safe.address)),
  }))

  const creation = found && 'creation' in found ? found.creation : null
  if (target && creation) return <DeployPanel safe={safe} origin={chain} creation={creation} target={target} onBack={() => setTarget(null)} />
  if (!withRecords) return <p className="muted small">Checking chains…</p>
  return (
    <div className="stack gap-sm">
      {withRecords.map((status) => (
        <ChainRow key={status.chain.chainId} safe={safe} status={status} onDeploy={() => setTarget(status.chain)} />
      ))}
      {found && 'error' in found && <p className="muted small">Can’t deploy elsewhere: {found.error}</p>}
    </div>
  )
}

const ChainRow = ({ safe, status, onDeploy }: { safe: DeployedSafe; status: ChainStatus; onDeploy(): void }) => {
  const navigate = useNavigate()
  const storage = useStorage()
  const { chain, deployed, deployable, waiting, record } = status
  const address = safe.address
  const addExisting = async () => {
    await assertRealSafe(clientFor(chain), address, chain.chainId)
    const onchain = await readSafe(clientFor(chain), address)
    const id = `${chain.chainId}:${address.toLowerCase()}`
    await storage.put('safes', {
      id,
      name: 'Imported Safe',
      chainId: chain.chainId,
      status: 'deployed',
      address,
      owners: onchain.owners,
      threshold: onchain.threshold,
      saltNonce: '',
      createdAt: new Date().toISOString(),
    })
    navigate(`/safes/${encodeURIComponent(id)}`)
  }
  return (
    <div className={`chain-row ${waiting.length && !deployed ? 'is-stranded' : ''}`}>
      <ChainPill chain={chain} />
      <span className="grow small">
        {deployed ? (
          <Badge tone="good">Deployed</Badge>
        ) : waiting.length ? (
          <strong className="text-bad">{fundsText(waiting)} waiting, Safe not deployed</strong>
        ) : (
          <span className="muted">Not deployed</span>
        )}
      </span>
      {deployed ? (
        record ? (
          <Button size="sm" variant="ghost" onClick={() => navigate(`/safes/${encodeURIComponent(record.id)}`)}>
            Open
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void addExisting()}>
            Add
          </Button>
        )
      ) : deployable ? (
        <Button size="sm" variant={waiting.length ? 'primary' : 'secondary'} onClick={onDeploy}>
          Duplicate here
        </Button>
      ) : (
        <span className="muted tiny" title={status.blocked}>
          {status.blocked ?? 'Can’t deploy at this address'}
        </span>
      )}
    </div>
  )
}

interface GasWallet {
  owner: Owner
  balance: bigint
}

const useGasWallets = (target: ChainConfig, owners: Owner[]) => {
  const [wallets, setWallets] = useState<GasWallet[] | null>(null)
  const key = owners.map((owner) => owner.id).join()
  useEffect(() => {
    let cancelled = false
    const client = clientFor(target)
    void Promise.all(
      owners.map(async (owner) => ({ owner, balance: await client.getBalance({ address: owner.address }).catch(() => 0n) })),
    ).then((result) => {
      if (!cancelled) setWallets(result.filter((wallet) => wallet.balance > 0n).sort((a, b) => (b.balance > a.balance ? 1 : -1)))
    })
    return () => {
      cancelled = true
    }
  }, [target.chainId, key])
  return wallets
}

type KeyProof = { state: 'proven'; at: string } | { state: 'expired'; at: string } | { state: 'contract'; reason: string }

const PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const keyProofMessage = (owner: Address, at: string) => `Lokhus key check\n\nI still hold the key ${owner}.\n\n${at}`

const DeployPanel = ({
  safe,
  origin,
  creation,
  target,
  onBack,
}: {
  safe: DeployedSafe
  origin: ChainConfig
  creation: SafeCreation
  target: ChainConfig
  onBack(): void
}) => {
  const navigate = useNavigate()
  const storage = useStorage()
  const { items: owners } = useCollection('owners')
  const { connection, openConnect } = useWallet()
  const gasCandidates =
    connection && !owners.some((owner) => sameAddress(owner.address, connection.address))
      ? [...owners, { id: connection.address.toLowerCase(), address: connection.address, label: shortAddress(connection.address) }]
      : owners
  const wallets = useGasWallets(target, gasCandidates)
  const [cost, setCost] = useState<bigint | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [proofs, setProofs] = useState<Record<string, KeyProof>>({})
  const [acceptMissing, setAcceptMissing] = useState(false)
  const setup = creationOwners(creation)
  const client = clientFor(target)
  const labelOf = (address: string) => owners.find((owner) => sameAddress(owner.address, address))?.label ?? shortAddress(address)
  const nameOf = (address: string) => `${labelOf(address)} (${shortAddress(address)})`
  const proofOf = (owner: string) => proofs[owner.toLowerCase()]
  const proven = setup.owners.filter((owner) => proofOf(owner)?.state === 'proven')
  const unproven = setup.owners.filter((owner) => proofOf(owner)?.state !== 'proven')
  const enoughKeys = proven.length >= setup.threshold
  const allKeys = unproven.length === 0
  const keysOk = enoughKeys && (allKeys || acceptMissing)
  const thresholdWord = setup.threshold === 1 ? 'one' : String(setup.threshold)

  useEffect(() => {
    const tx = creationTx(creation)
    void Promise.all([client.estimateGas({ to: tx.to, data: tx.data }), client.getGasPrice()])
      .then(([gas, price]) => setCost((gas * price * 12n) / 10n))
      .catch(() => setCost(null))
  }, [target.chainId])

  const enough = (balance: bigint) => balance > 0n && (cost === null || balance >= cost)
  const best = wallets?.find((wallet) => enough(wallet.balance))
  const gasOf = (address: string) => wallets?.find((wallet) => sameAddress(wallet.owner.address, address))?.balance ?? 0n
  const canPay = !!connection && enough(gasOf(connection.address))
  const connectedOwner = connection ? setup.owners.find((owner) => sameAddress(owner, connection.address)) : undefined

  const run = async (label: string, task: () => Promise<void>) => {
    setError(null)
    setBusy(label)
    try {
      await task()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const ownerKey = owners.map((owner) => `${owner.id}:${owner.keyProof?.at ?? ''}`).join()

  useEffect(() => {
    let cancelled = false
    const originClient = clientFor(origin)
    void Promise.all(
      setup.owners.map(async (owner): Promise<[string, KeyProof | undefined]> => {
        const id = owner.toLowerCase()
        if ((await isDeployed(originClient, owner).catch(() => false)) && !(await isDeployed(client, owner).catch(() => false)))
          return [id, { state: 'contract', reason: `a smart account that does not exist on ${target.name}` }]
        const proof = owners.find((candidate) => sameAddress(candidate.address, owner))?.keyProof
        if (!proof || !proof.message.includes(getAddress(owner))) return [id, undefined]
        if (Date.now() - Date.parse(proof.at) > PROOF_MAX_AGE_MS) return [id, { state: 'expired', at: proof.at }]
        const valid = await originClient.verifyMessage({ address: owner, message: proof.message, signature: proof.signature }).catch(() => false)
        return [id, valid ? { state: 'proven', at: proof.at } : undefined]
      }),
    ).then((entries) => {
      if (!cancelled) setProofs(Object.fromEntries(entries.filter((entry): entry is [string, KeyProof] => !!entry[1])))
    })
    return () => {
      cancelled = true
    }
  }, [ownerKey, origin.chainId, target.chainId])

  const prove = (owner: Address) =>
    run(`prove:${owner}`, async () => {
      if (!connection || !sameAddress(connection.address, owner)) return openConnect(origin)
      const at = new Date().toISOString()
      const message = keyProofMessage(getAddress(owner), at)
      const signature = await signMessageWith(connection, origin, message)
      if (!(await clientFor(origin).verifyMessage({ address: owner, message, signature })))
        throw new Error(`That signature is not from ${nameOf(owner)}`)
      const id = owner.toLowerCase()
      const existing = await storage.get('owners', id)
      await storage.put('owners', { ...(existing ?? { id, address: getAddress(owner), label: 'Unnamed signer' }), keyProof: { at, message, signature } })
    })

  const deploy = () =>
    run('deploy', async () => {
      if (!connection) return openConnect(target)
      if (!keysOk) throw new Error(`Prove ${thresholdWord} of the original keys first`)
      await checkCreationOn(client, target.chainId, creation, safe.address)
      const receipt = (await isDeployed(client, safe.address)) ? null : await sendAndWait(connection, target, creationTx(creation))
      await waitForDeployment(client, safe.address)
      const onchain = await readSafe(client, safe.address)
      const record: SafeRecord = {
        id: crypto.randomUUID(),
        name: safe.name,
        chainId: target.chainId,
        status: 'deployed',
        address: safe.address,
        owners: onchain.owners,
        threshold: onchain.threshold,
        saltNonce: creation.saltNonce,
        creation: { ...creation, txHash: receipt?.transactionHash },
        deployTxHash: receipt?.transactionHash,
        deployBlock: receipt?.blockNumber.toString(),
        createdAt: new Date().toISOString(),
      }
      await storage.put('safes', record)
      navigate(`/safes/${encodeURIComponent(record.id)}`)
    })

  return (
    <div className="stack gap-md">
      <div className="row gap-sm">
        <button className="link-btn small" onClick={onBack}>
          ← All chains
        </button>
        <span className="grow" />
        <ChainPill chain={target} />
      </div>

      <div className="explain">
        <p>
          <strong>How this works</strong>
        </p>
        <ol>
          <li>
            The copy on {target.name} gets the same address, <span className="mono">{shortAddress(safe.address)}</span>. That only works with
            the keys this Safe was created with:{' '}
            <strong>
              {setup.threshold} of {setup.owners.length}
            </strong>
            .
          </li>
          <li>
            Once it exists, it is its own Safe. You can add, remove or replace keys on it, like on any Safe. Each change needs{' '}
            {thresholdWord} of its keys to sign.
          </li>
          <li>
            So first, show which of these keys you still have. With fewer than {thresholdWord}, nobody can ever move what is sent there.
          </li>
        </ol>
      </div>

      <div className={`wizard-step ${keysOk ? 'is-done' : 'is-active'}`}>
        <span className="wizard-index">{keysOk ? '✓' : 1}</span>
        <div className="stack gap-sm grow">
          <strong>Prove your keys: sign a short message with each</strong>
          <span className="muted tiny">A proof counts for 7 days, also for duplicating to other chains.</span>
          <div className="stack gap-xs">
            {setup.owners.map((owner) => {
              const proof = proofOf(owner)
              const isConnected = !!connectedOwner && sameAddress(connectedOwner, owner)
              return (
                <div key={owner} className={`signer-row ${proof?.state === 'proven' ? 'is-signed' : ''}`}>
                  <Avatar address={owner} />
                  <span className="grow">
                    <strong>{labelOf(owner)}</strong>
                    <span className="muted tiny block">
                      {shortAddress(owner)}
                      {!safe.owners.some((current) => sameAddress(current, owner)) && ' · removed from this Safe since'}
                      {proof?.state === 'contract' && ` · ${proof.reason}, can’t sign there`}
                      {proof?.state === 'proven' && ` · proven ${timeAgo(proof.at)}`}
                      {proof?.state === 'expired' && ` · proof from ${timeAgo(proof.at)} is older than 7 days`}
                    </span>
                  </span>
                  {proof?.state === 'proven' ? (
                    <Badge tone="good">Proven</Badge>
                  ) : proof?.state === 'contract' ? (
                    <Badge tone="bad">Unusable</Badge>
                  ) : isConnected ? (
                    <Button size="sm" variant="primary" busy={busy === `prove:${owner}`} onClick={() => void prove(owner)}>
                      Sign
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => openConnect(origin)}>
                      Connect
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          {connection && !connectedOwner && (
            <p className="small">{nameOf(connection.address)} is connected, but it is not one of these keys.</p>
          )}

          {allKeys ? (
            <p className="hint-good">All {setup.owners.length} keys proven.</p>
          ) : enoughKeys ? (
            <div className="hint stack gap-xs">
              <span>
                {proven.length} of {setup.owners.length} proven, enough to control the new Safe. Not proven:{' '}
                <strong>{unproven.map(labelOf).join(', ')}</strong>.
              </span>
              <span>
                {unproven.length === 1 ? 'It' : 'They'} will still be an owner there. If {unproven.length === 1 ? 'that key is' : 'those keys are'} lost
                or in someone else’s hands, remove {unproven.length === 1 ? 'it' : 'them'} from the new Safe right after creating it.
              </span>
              <label className="setup-confirm">
                <input type="checkbox" checked={acceptMissing} onChange={(event) => setAcceptMissing(event.target.checked)} />
                <span>Continue without {unproven.map(labelOf).join(', ')}</span>
              </label>
            </div>
          ) : (
            <p className="small">
              {proven.length} of {thresholdWord} needed so far.
            </p>
          )}
        </div>
      </div>

      <div className={`wizard-step ${keysOk ? 'is-active' : ''}`}>
        <span className="wizard-index">2</span>
        <div className="stack gap-xs grow">
          <strong>
            Create it on {target.name}
            {cost !== null ? ` (≈ ${formatAmount(cost, 18, 5)} ${target.nativeSymbol} gas)` : ''}
          </strong>
          {!keysOk ? null : !wallets ? (
            <p className="muted small">Checking your wallets for {target.nativeSymbol}…</p>
          ) : !best ? (
            <p className="hint">
              None of your wallets has {target.nativeSymbol} on {target.name}. Send a little to any wallet, then come back.
            </p>
          ) : canPay ? (
            <Button size="sm" variant="primary" busy={busy === 'deploy'} onClick={() => void deploy()}>
              Create with {labelOf(connection!.address)}
            </Button>
          ) : (
            <>
              <p className="small">
                {connection ? `${nameOf(connection.address)} has no ${target.nativeSymbol} on ${target.name}. ` : ''}
                Connect <strong>{nameOf(best.owner.address)}</strong>, it holds {formatAmount(best.balance, 18, 5)} {target.nativeSymbol}. Any
                wallet can pay; paying gives it no say over the Safe.
              </p>
              <Button size="sm" variant="primary" onClick={() => openConnect(target)}>
                {connection ? 'Switch to' : 'Connect'} {labelOf(best.owner.address)}
              </Button>
            </>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
    </div>
  )
}
