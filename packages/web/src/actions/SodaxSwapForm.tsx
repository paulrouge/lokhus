import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, zeroAddress } from 'viem'
import {
  DEFAULT_CHAINS,
  SODAX_DEFAULT_MINUTES,
  SODAX_FILL_BUFFER_MINUTES,
  erc20Abi,
  fetchSodaxTokens,
  formatTokenAmount,
  quoteSodaxSwap,
  sodaxSeenQuote,
  sodaxTokenLogo,
  type ActionContext,
  type SodaxToken,
} from '@msa/core'
import { Button, Modal } from '../components/ui.tsx'
import { stockLogo } from './stockLogos.ts'
import { StockRisk } from './StockRisk.tsx'
import { StocksAcknowledgment } from './StocksAcknowledgment.tsx'
import { clientFor, useStorage } from '../state/data.tsx'
import { errorMessage, shortAddress } from '../lib/format.ts'

type Input = Record<string, string>
type Quote = Awaited<ReturnType<typeof quoteSodaxSwap>>

const SLIPPAGE_PRESETS = ['0.5', '1', '2']
const MINUTE_PRESETS = ['3', '5', '10']

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export const TokenIcon = ({
  symbol,
  size = 26,
  trusted = true,
  stock = false,
}: {
  symbol: string
  size?: number
  trusted?: boolean
  stock?: boolean
}) => {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [symbol, stock])
  const src = stock ? stockLogo(symbol) : sodaxTokenLogo(symbol)
  return failed || !trusted || !src ? (
    <span className="token-dot" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {symbol.slice(0, 1)}
    </span>
  ) : (
    <img className="token-icon" src={src} alt="" width={size} height={size} onError={() => setFailed(true)} />
  )
}

export const useLogoCheck = (chainId: number) => {
  const [sodaxTokens, setSodaxTokens] = useState<SodaxToken[]>([])
  useEffect(() => {
    let cancelled = false
    fetchSodaxTokens(chainId)
      .then((list) => !cancelled && setSodaxTokens(list))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [chainId])
  const trusted = (symbol: string, address?: string) => {
    if (!address || address === zeroAddress) return true
    const pinned = DEFAULT_CHAINS.find((chain) => chain.chainId === chainId)?.tokens ?? []
    return [...pinned, ...sodaxTokens].some((token) => same(token.address, address) && token.symbol.toLowerCase() === symbol.toLowerCase())
  }
  const isStock = (address?: string) => sodaxTokens.some((token) => token.stock && same(token.address, address))
  return { trusted, isStock }
}

export const useSafeBalances = (context: ActionContext, tokens: SodaxToken[]) => {
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map())
  useEffect(() => {
    if (tokens.length === 0) return
    let cancelled = false
    const safe = context.safe.address
    const erc20s = tokens.filter((token) => token.address !== zeroAddress)
    void Promise.all([
      context.client.getBalance({ address: safe }).catch(() => null),
      context.client
        .multicall({
          contracts: erc20s.map((token) => ({ address: token.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [safe] as const })),
          allowFailure: true,
        })
        .catch(() => []),
    ]).then(([native, results]) => {
      if (cancelled) return
      const next = new Map<string, bigint>()
      if (native !== null) next.set(zeroAddress, native)
      results.forEach((result, index) => {
        if (result.status === 'success') next.set(erc20s[index]!.address.toLowerCase(), result.result as bigint)
      })
      setBalances(next)
    })
    return () => {
      cancelled = true
    }
  }, [context, tokens])
  return balances
}

const balanceOf = (balances: Map<string, bigint>, token?: SodaxToken) =>
  token ? balances.get(token.address === zeroAddress ? zeroAddress : token.address.toLowerCase()) : undefined

const TokenPicker = ({
  open,
  tokens,
  balances,
  listed,
  onPick,
  onClose,
}: {
  open: boolean
  tokens: SodaxToken[]
  balances: Map<string, bigint>
  listed: Set<string>
  onPick(token: SodaxToken): void
  onClose(): void
}) => {
  const [query, setQuery] = useState('')
  useEffect(() => setQuery(''), [open])
  const needle = query.trim().toLowerCase()
  const visible = tokens
    .filter((token) => !needle || `${token.symbol} ${token.name} ${token.address}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      const held = Number((balanceOf(balances, b) ?? 0n) > 0n) - Number((balanceOf(balances, a) ?? 0n) > 0n)
      const onList = Number(listed.has(b.address.toLowerCase())) - Number(listed.has(a.address.toLowerCase()))
      return held || onList || a.symbol.localeCompare(b.symbol)
    })

  return (
    <Modal open={open} title="Select a token" onClose={onClose}>
      <input autoFocus placeholder="Search name, symbol or address" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="token-picker-list">
        {visible.map((token) => {
          const balance = balanceOf(balances, token)
          return (
            <button key={token.address} className="token-row" onClick={() => onPick(token)}>
              <TokenIcon symbol={token.symbol} stock={token.stock} size={32} />
              <span className="grow">
                <strong>{token.symbol}</strong>
                <span className="muted tiny block">
                  {token.name} · {token.address === zeroAddress ? 'native coin' : shortAddress(token.address)}
                  {listed.has(token.address.toLowerCase()) ? ' · on your list' : ''}
                </span>
              </span>
              {balance !== undefined && balance > 0n && <span className="mono small">{formatTokenAmount(balance, token.decimals)}</span>}
            </button>
          )
        })}
        {visible.length === 0 && <p className="muted small">No token matches.</p>}
      </div>
    </Modal>
  )
}

const TokenButton = ({ token, onClick }: { token?: SodaxToken; onClick(): void }) => (
  <button className="token-select" onClick={onClick}>
    {token ? <TokenIcon symbol={token.symbol} stock={token.stock} /> : <span className="token-dot">?</span>}
    <strong>{token?.symbol ?? 'Select'}</strong>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>
)

const AddToTokenList = ({ token, context }: { token: SodaxToken; context: ActionContext }) => {
  const storage = useStorage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { chain } = context

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const client = clientFor(chain)
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token.address, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' }),
      ])
      if (symbol !== token.symbol || decimals !== token.decimals)
        throw new Error(`Onchain this token is ${symbol} with ${decimals} decimals, SODAX said ${token.symbol} with ${token.decimals}`)
      const clash = [chain.nativeSymbol, ...chain.tokens.map((listed) => listed.symbol)].some(
        (existing) => existing.toLowerCase() === symbol.toLowerCase(),
      )
      if (clash) throw new Error(`${symbol} is already on your ${chain.name} list under another address`)
      await storage.put('chains', { ...chain, tokens: [...chain.tokens, { address: token.address, symbol, decimals }] })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="swap-note">
      {token.symbol} is not on your {chain.name} token list yet. Add it to trade it and see it in balances.{' '}
      <Button size="sm" busy={busy} onClick={() => void add()}>
        Add {token.symbol} to token list
      </Button>
      {error && <span className="swap-warning block">{error}</span>}
    </span>
  )
}

export const SodaxStocksForm = (props: { input: Input; onChange(next: Input): void; context: ActionContext }) => (
  <StocksAcknowledgment context={props.context}>
    <SodaxSwapForm {...props} stocks />
  </StocksAcknowledgment>
)

export const SodaxSwapForm = ({
  input,
  onChange,
  context,
  stocks = false,
}: {
  input: Input
  onChange(next: Input): void
  context: ActionContext
  stocks?: boolean
}) => {
  const [sodaxTokens, setSodaxTokens] = useState<SodaxToken[]>([])
  const [tokensError, setTokensError] = useState<string | null>(null)
  const [picking, setPicking] = useState<'sell' | 'buy' | null>(null)
  const [quote, setQuote] = useState<{ value: Quote | null; loading: boolean; error?: string }>({ value: null, loading: false })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const latestInput = useRef(input)
  latestInput.current = input
  const listed = useMemo(() => new Set(context.chain.tokens.map((token) => token.address.toLowerCase())), [context.chain.tokens])
  const tokens = useMemo(
    () =>
      sodaxTokens.filter(
        (token) => token.address === zeroAddress || listed.has(token.address.toLowerCase()) || (stocks && token.stock),
      ),
    [sodaxTokens, listed, stocks],
  )
  const balances = useSafeBalances(context, tokens)
  const slippage = input.slippage || '1'
  const minutes = input.minutes || String(SODAX_DEFAULT_MINUTES)
  const sell = tokens.find((token) => same(token.address, input.sell))
  const buy = tokens.find((token) => same(token.address, input.buy))
  const sellBalance = balanceOf(balances, sell)

  useEffect(() => {
    let cancelled = false
    fetchSodaxTokens(context.chain.chainId)
      .then((list) => !cancelled && setSodaxTokens(list))
      .catch((cause) => !cancelled && setTokensError(errorMessage(cause)))
    return () => {
      cancelled = true
    }
  }, [context.chain.chainId])

  useEffect(() => {
    if (tokens.length === 0 || (input.sell && input.buy)) return
    const usdc = tokens.find((token) => token.symbol === 'USDC')
    const native = tokens.find((token) => token.address === zeroAddress)
    const stock = tokens.find((token) => token.symbol === 'SPY' && token.stock) ?? tokens.find((token) => token.stock)
    const target = stocks ? stock : native
    onChange({ ...input, sell: input.sell ?? usdc?.address ?? '', buy: input.buy ?? target?.address ?? '' })
  }, [tokens])

  useEffect(() => {
    if (!sell || !buy || !input.amount || Number(input.amount) <= 0) return setQuote({ value: null, loading: false })
    let cancelled = false
    setQuote((current) => ({ ...current, loading: true, error: undefined }))
    const timer = setTimeout(() => {
      quoteSodaxSwap({ ...input, slippage }, context.chain.chainId, context.chain.name)
        .then((value) => {
          if (cancelled) return
          setQuote({ value, loading: false })
          onChange({ ...latestInput.current, seenQuote: sodaxSeenQuote(value) })
        })
        .catch((cause) => !cancelled && setQuote({ value: null, loading: false, error: errorMessage(cause) }))
    }, 450)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [input.sell, input.buy, input.amount, slippage, context, tokens])

  const set = (patch: Input) => onChange({ ...input, ...patch })
  const pick = (token: SodaxToken) => {
    if (picking === 'sell') set({ sell: token.address, buy: same(token.address, input.buy) ? (input.sell ?? '') : (input.buy ?? ''), amount: '' })
    if (picking === 'buy') set({ buy: token.address, sell: same(token.address, input.sell) ? (input.buy ?? '') : (input.sell ?? '') })
    setPicking(null)
  }
  const flip = () => set({ sell: input.buy ?? '', buy: input.sell ?? '', amount: '' })
  const insufficient = sellBalance !== undefined && quote.value !== null && quote.value.amount > sellBalance
  const received = quote.value ? formatTokenAmount(quote.value.quoted, quote.value.buy.decimals) : ''
  const buyUnlisted = buy && buy.address !== zeroAddress && !listed.has(buy.address.toLowerCase())
  const otherSide = picking === 'sell' ? buy : sell
  const pickable = stocks ? tokens.filter((token) => !!token.stock !== !!otherSide?.stock) : tokens

  if (tokensError) return <p className="swap-error">Could not load SODAX tokens: {tokensError}</p>

  return (
    <div className="swap">
      <div className={`swap-box ${insufficient ? 'is-bad' : ''}`}>
        <div className="swap-box-head">
          <span>You sell</span>
          {sell && sellBalance !== undefined && (
            <button className="swap-max" onClick={() => set({ amount: formatUnits(sellBalance, sell.decimals) })}>
              Safe balance {formatTokenAmount(sellBalance, sell.decimals)} · Max
            </button>
          )}
        </div>
        <div className="swap-box-row">
          <input
            className="swap-amount"
            inputMode="decimal"
            placeholder="0"
            value={input.amount ?? ''}
            onChange={(event) => set({ amount: event.target.value.replace(',', '.').replace(/[^0-9.]/g, '') })}
          />
          <TokenButton token={sell} onClick={() => setPicking('sell')} />
        </div>
        {insufficient && <span className="swap-warning">More than the Safe holds</span>}
        {stocks && sell?.stock && !listed.has(sell.address.toLowerCase()) && <AddToTokenList token={sell} context={context} />}
      </div>

      <button className="swap-flip" onClick={flip} aria-label="Flip direction" title="Flip direction">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M6 13l6 6 6-6" />
        </svg>
      </button>

      <div className="swap-box is-receive">
        <div className="swap-box-head">
          <span>You receive, on {context.chain.name}, into this Safe</span>
        </div>
        <div className="swap-box-row">
          <span className={`swap-amount ${quote.loading ? 'is-loading' : ''} ${received ? '' : 'is-empty'}`}>{received || '0'}</span>
          <TokenButton token={buy} onClick={() => setPicking('buy')} />
        </div>
        {buyUnlisted && stocks && <AddToTokenList token={buy} context={context} />}
        {buyUnlisted && !stocks && <span className="swap-note">{buy.symbol} is not on your token list yet, so balances and Activity hide it until you add it on Chains.</span>}
      </div>

      <div className="swap-rows">
        <div>
          <span>Minimum received</span>
          <strong>{quote.value && buy ? `${formatTokenAmount(quote.value.minOutput, quote.value.buy.decimals)} ${buy.symbol}` : '—'}</strong>
        </div>
        <div>
          <span>Rate</span>
          <span>{quote.value && sell && buy ? `1 ${sell.symbol} ≈ ${quote.value.rate.toPrecision(6)} ${buy.symbol}` : '—'}</span>
        </div>
        <div>
          <span>Sign and execute within</span>
          <span>{minutes} min after Review</span>
        </div>
        <div>
          <span>Solver fill window</span>
          <span>+{SODAX_FILL_BUFFER_MINUTES} min</span>
        </div>
      </div>

      <button className="swap-settings-toggle" onClick={() => setSettingsOpen((open) => !open)}>
        {settingsOpen ? '▾' : '▸'} Settings · {slippage}% slippage · {minutes} min to sign
      </button>
      {settingsOpen && (
        <div className="swap-settings">
          <div>
            <span className="muted small">Max slippage</span>
            <div className="chips">
              {SLIPPAGE_PRESETS.map((value) => (
                <button key={value} className={`chip ${slippage === value ? 'is-on' : ''}`} onClick={() => set({ slippage: value })}>
                  {value}%
                </button>
              ))}
              <input
                className="chip-input"
                placeholder="Custom"
                value={SLIPPAGE_PRESETS.includes(slippage) ? '' : slippage}
                onChange={(event) => set({ slippage: event.target.value })}
              />
            </div>
          </div>
          <div>
            <span className="muted small">Time to collect every signature and execute</span>
            <div className="chips">
              {MINUTE_PRESETS.map((value) => (
                <button key={value} className={`chip ${minutes === value ? 'is-on' : ''}`} onClick={() => set({ minutes: value })}>
                  {value} min
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {quote.error && <p className="swap-error">{quote.error}</p>}
      {stocks && <StockRisk />}
      <p className="muted tiny">
        {stocks
          ? `${tokens.filter((token) => token.stock).length} stock tokens (SODAX copies of Robinhood tokens) on ${context.chain.name}, traded through SODAX.`
          : `Same-chain only, ${tokens.length} tokens on ${context.chain.name}.`} The quote is locked when you press Review, and the signing clock
        starts then.
      </p>

      <TokenPicker
        open={picking !== null}
        tokens={pickable}
        balances={balances}
        listed={listed}
        onPick={pick}
        onClose={() => setPicking(null)}
      />
    </div>
  )
}
