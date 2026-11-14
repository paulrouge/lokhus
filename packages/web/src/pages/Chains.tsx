import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { assertSecureUrl, createChainClient, erc20Abi, type ChainConfig, type Token } from '@msa/core'
import { useChains, useStorage } from '../state/data.tsx'
import { Badge, Button, Card, ErrorNote, Field } from '../components/ui.tsx'
import { NotesBox } from '../components/Notes.tsx'
import { errorMessage } from '../lib/format.ts'

const blankChain = (): ChainConfig => ({
  id: '',
  chainId: 0,
  name: '',
  nativeSymbol: 'ETH',
  rpcUrls: [],
  explorerUrl: '',
  tokens: [],
  safeVersion: '1.4.1',
})

const ChainEditor = ({ initial, isNew, onDone }: { initial: ChainConfig; isNew?: boolean; onDone?(): void }) => {
  const storage = useStorage()
  const [chain, setChain] = useState(initial)
  const [rpcText, setRpcText] = useState(initial.rpcUrls.join('\n'))
  const [tokenAddress, setTokenAddress] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const withRpc = (): ChainConfig => ({
    ...chain,
    id: String(chain.chainId),
    rpcUrls: rpcText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  })

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      const next = withRpc()
      if (!next.name || !next.chainId || next.rpcUrls.length === 0) throw new Error('Name, chain id and at least one RPC are required')
      next.rpcUrls.forEach(assertSecureUrl)
      if (next.explorerUrl) assertSecureUrl(next.explorerUrl)
      for (const url of next.rpcUrls) {
        const reported = await createChainClient({ ...next, rpcUrls: [url] }).getChainId()
        if (reported !== next.chainId) throw new Error(`${url} reports chain ${reported}, expected ${next.chainId}`)
      }
      await storage.put('chains', next)
      setStatus(`Saved · ${next.rpcUrls.length === 1 ? 'RPC' : `all ${next.rpcUrls.length} RPCs`} verified`)
      onDone?.()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const addToken = async () => {
    setError(null)
    if (!isAddress(tokenAddress)) return setError('Token address is not valid')
    setBusy(true)
    try {
      const client = createChainClient(withRpc())
      const address = getAddress(tokenAddress)
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
      ])
      const clash = [chain.nativeSymbol, ...chain.tokens.filter((existing) => existing.address !== address).map((existing) => existing.symbol)].find(
        (existing) => existing.toLowerCase() === symbol.trim().toLowerCase(),
      )
      if (clash && !window.confirm(`WARNING: ${clash} is already on this list. A second token called ${symbol} is usually a fake.\n\n${address}\n\nAdd it anyway?`))
        return
      const token: Token = { address, symbol, decimals }
      setChain((previous) => ({ ...previous, tokens: [...previous.tokens.filter((existing) => existing.address !== address), token] }))
      setTokenAddress('')
    } catch (cause) {
      setError(`Could not read token: ${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack gap-md">
      <div className="grid-3">
        <Field label="Name">
          <input value={chain.name} onChange={(event) => setChain({ ...chain, name: event.target.value })} />
        </Field>
        <Field label="Chain id">
          <input
            className="mono"
            value={chain.chainId || ''}
            disabled={!isNew}
            onChange={(event) => setChain({ ...chain, chainId: Number(event.target.value.replace(/\D/g, '')) })}
          />
        </Field>
        <Field label="Native symbol">
          <input value={chain.nativeSymbol} onChange={(event) => setChain({ ...chain, nativeSymbol: event.target.value })} />
        </Field>
      </div>
      <Field label="RPC URLs" hint="One per line, https only (plain http only for a node on this machine). Tried in order; later ones are fallbacks.">
        <textarea className="mono" rows={3} value={rpcText} onChange={(event) => setRpcText(event.target.value)} />
      </Field>
      <Field label="Block explorer">
        <input value={chain.explorerUrl} onChange={(event) => setChain({ ...chain, explorerUrl: event.target.value })} placeholder="https://…" />
      </Field>
      <Field label="Tokens">
        <div className="token-list">
          {chain.tokens.map((token) => (
            <span key={token.address} className="token-chip">
              <strong>{token.symbol}</strong>
              <span className="mono tiny muted">{token.address.slice(0, 8)}…</span>
              <button
                className="icon-btn"
                onClick={() => setChain({ ...chain, tokens: chain.tokens.filter((existing) => existing.address !== token.address) })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="add-owner">
          <input className="mono" placeholder="Token address 0x…" value={tokenAddress} onChange={(event) => setTokenAddress(event.target.value.trim())} />
          <Button onClick={() => void addToken()} disabled={!tokenAddress} busy={busy && !!tokenAddress}>
            Add token
          </Button>
        </div>
      </Field>
      <ErrorNote error={error} />
      <div className="row gap-sm">
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {isNew ? 'Add chain' : 'Save changes'}
        </Button>
        {status && <span className="muted small">{status}</span>}
      </div>
    </div>
  )
}

export const ChainSettings = () => {
  const { chains } = useChains()
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  return (
    <section id="chains" className="stack gap-md settings-section">
      <div className="settings-section-head">
        <div>
          <h2>Chains</h2>
          <p className="muted">Networks Lokhus can use, with their RPCs and the tokens it shows.</p>
        </div>
        <Button onClick={() => setAdding(true)}>Add chain</Button>
      </div>

      {adding && (
        <Card title="New chain" subtitle="Safe contracts must already be deployed on it (most EVM chains have them).">
          <ChainEditor initial={blankChain()} isNew onDone={() => setAdding(false)} />
        </Card>
      )}

      {chains.map((chain) => (
        <Card
          key={chain.chainId}
          title={
            <span className="row gap-sm">
              {chain.name} <Badge>#{chain.chainId}</Badge>
            </span>
          }
          subtitle={`${chain.nativeSymbol} · ${chain.tokens.length} tokens · ${chain.rpcUrls.length} RPCs`}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setOpenId(openId === chain.chainId ? null : chain.chainId)}>
              {openId === chain.chainId ? 'Close' : 'Edit'}
            </Button>
          }
        >
          {openId === chain.chainId ? (
            <ChainEditor initial={chain} />
          ) : (
            <NotesBox entityType="chain" entityId={chain.id} placeholder="RPC quirks, bridges you use, gas notes…" />
          )}
        </Card>
      ))}
    </section>
  )
}
