import { useEffect, useState, type ReactNode } from 'react'
import { getAddress, recoverMessageAddress } from 'viem'
import { ACKNOWLEDGMENTS, acknowledgmentMessage, safeAbi, type ActionContext, type AcknowledgmentFields } from '@msa/core'
import { Button, ErrorNote } from '../components/ui.tsx'
import { useWallet } from '../state/wallet.tsx'
import { acknowledgmentFor, saveAcknowledgment, useAuth } from '../lib/auth.ts'
import { signMessageWith } from '../lib/signing.ts'
import { errorMessage, shortAddress } from '../lib/format.ts'
import { StockRisk } from './StockRisk.tsx'

const PREVIEW_FIELDS = {
  signer: '<your signer>',
  safe: '<this Safe>',
  chainId: 0,
  blockNumber: '<current block>',
  date: '<now>',
}

export const StocksAcknowledgment = ({ context, children }: { context: ActionContext; children: ReactNode }) => {
  const status = useAuth()
  if (!status) return <p className="muted small">Checking your acknowledgment…</p>
  return status.mode === 'hosted' ? <HostedAcknowledgment context={context}>{children}</HostedAcknowledgment> : <>{children}</>
}

const HostedAcknowledgment = ({ context, children }: { context: ActionContext; children: ReactNode }) => {
  const { connection, openConnect } = useWallet()
  const [state, setState] = useState<'loading' | 'needed' | 'done'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    acknowledgmentFor('stocks')
      .then((result) => !cancelled && setState(result.acknowledgment || !result.required ? 'done' : 'needed'))
      .catch((cause) => {
        if (cancelled) return
        setState('needed')
        setError(errorMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'done') return <>{children}</>
  if (state === 'loading') return <p className="muted small">Checking your acknowledgment…</p>

  const { client, chain, safe } = context
  const isOwner = !!connection && safe.owners.some((owner) => owner.toLowerCase() === connection.address.toLowerCase())

  const sign = async () => {
    if (!connection) return openConnect(chain)
    setBusy(true)
    setError(null)
    try {
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
      const owners = await client.readContract({ address: safe.address, abi: safeAbi, functionName: 'getOwners', blockNumber })
      if (!owners.some((owner) => owner.toLowerCase() === connection.address.toLowerCase()))
        throw new Error(`${shortAddress(connection.address)} is not an owner of this Safe. Connect one of its signers.`)
      const code = await client.getCode({ address: connection.address })
      if (code && code !== '0x' && !code.startsWith('0xef0100'))
        throw new Error('Sign with a key wallet. Smart account signers cannot sign this acknowledgment.')
      const fields: AcknowledgmentFields = {
        kind: 'stocks',
        signer: getAddress(connection.address),
        safe: getAddress(safe.address),
        chainId: chain.chainId,
        blockNumber: blockNumber.toString(),
        date: new Date().toISOString(),
      }
      const message = acknowledgmentMessage(fields)
      const signature = await signMessageWith(connection, chain, message)
      if ((await recoverMessageAddress({ message, signature })).toLowerCase() !== connection.address.toLowerCase())
        throw new Error('That signature is not from the connected signer')
      await saveAcknowledgment({ ...fields, message, signature })
      setState('done')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack gap-sm">
      <strong>Before your first stock trade</strong>
      <p className="muted small">
        Read what these tokens are, then sign the statement below with one of this Safe's signers. Signing costs nothing and sends no
        transaction. Lokhus keeps the signed statement as a record, readable by us, and asks again only if the text changes.
      </p>
      <StockRisk />
      <pre className="ack-message">{acknowledgmentMessage({ kind: 'stocks', ...PREVIEW_FIELDS })}</pre>
      <ErrorNote error={error} />
      <div className="row gap-sm">
        <Button variant="primary" busy={busy} onClick={() => void sign()}>
          {connection ? (isOwner ? `Sign with ${shortAddress(connection.address)}` : 'Sign with a signer') : 'Connect a signer'}
        </Button>
        <span className="muted tiny">Version {ACKNOWLEDGMENTS.stocks.version}</span>
      </div>
    </div>
  )
}
