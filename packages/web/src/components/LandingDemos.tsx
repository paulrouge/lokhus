import { useState } from 'react'
import { Avatar, Badge, Button, Card } from './ui.tsx'
import { TokenIcon } from '../actions/SodaxSwapForm.tsx'

const SAFE = '0x4f1c6e2a9b8d3f7e5a0c1b2d3e4f5a6b7c8d9e0f'
const COLD = '0x9a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const SIGNERS = [
  { address: '0x1d7e3a5b9c2f4e6a8b0c1d2e3f4a5b6c7d8e9f01', label: 'Ledger', via: 'Ledger' },
  { address: '0x6b2c4d8e0f1a3b5c7d9e2f4a6b8c0d1e3f5a7b92', label: 'Phone', via: 'WalletConnect' },
  { address: '0xc3d5e7f9a1b2c4d6e8f0a2b4c6d8e0f1a3b5c7d3', label: 'Card', via: 'Tangem' },
]
const STABLE_RATE = 0.9996

const parseAmount = (text: string) => {
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : 0
}

const Sticker = ({ children }: { children: string }) => (
  <span className="landing-sticker" aria-hidden>
    {children}
  </span>
)

const formatDemo = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

const Delta = ({ address, label, change }: { address: string; label: string; change: string }) => (
  <div className="row gap-sm">
    <Avatar address={address} size={22} />
    <strong className="grow">{label}</strong>
    <span className={`mono small ${change.startsWith('−') ? 'text-bad' : 'text-good'}`}>{change}</span>
    <TokenIcon symbol="USDC" size={18} />
  </div>
)

export const SimulationDemo = () => {
  const [text, setText] = useState('100')
  const amount = parseAmount(text)
  return (
    <div className="landing-demo stack gap-md">
      <label className="landing-demo-input">
        <span className="muted small">Send</span>
        <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} aria-label="Amount of USDC" />
        <span className="muted small">USDC to your cold wallet</span>
      </label>
      <Card title="What happens if executed now" actions={<Badge tone={amount ? 'good' : 'neutral'}>{amount ? 'Simulated' : 'Nothing to send'}</Badge>}>
        {amount ? (
          <div className="stack gap-sm">
            <p className="hint-good">Succeeds.</p>
            <Delta address={SAFE} label="This Safe" change={`−${formatDemo(amount)} USDC`} />
            <Delta address={COLD} label="Cold wallet" change={`+${formatDemo(amount)} USDC`} />
          </div>
        ) : (
          <p className="muted small">Type an amount to see the balance changes.</p>
        )}
      </Card>
    </div>
  )
}

export const SigningDemo = () => {
  const [signed, setSigned] = useState(['Ledger'])
  const threshold = 2
  const missing = threshold - signed.length
  const next = SIGNERS.find((signer) => !signed.includes(signer.label))
  return (
    <div className="landing-demo">
      <Sticker>Click to sign</Sticker>
      <Card title="Signatures" subtitle={`${threshold} of ${SIGNERS.length} owners must sign`}>
        <div className="stack gap-sm">
          {SIGNERS.map((signer) => (
            <div key={signer.label} className={`signer-row ${signed.includes(signer.label) ? 'is-signed' : ''}`}>
              <Avatar address={signer.address} />
              <span className="grow">
                <strong>{signer.label}</strong>
                <span className="muted tiny block">via {signer.via}</span>
              </span>
              {signed.includes(signer.label) ? <Badge tone="good">Signed</Badge> : <Badge>Not signed</Badge>}
            </div>
          ))}
        </div>
        {missing > 0 && next ? (
          <div className="signer-hint">
            <div className="signer-hint-head">
              <span className="signer-hint-title">1 more signature needed</span>
              <span className="signer-hint-reason">Ledger has already signed. Switch to one of these signers:</span>
            </div>
            <Button size="sm" variant="primary" onClick={() => setSigned([...signed, next.label])}>
              Sign with {next.label}
            </Button>
          </div>
        ) : (
          <div className="signer-hint is-ready">
            <div className="signer-hint-head">
              <span className="signer-hint-title">All {threshold} signatures are in</span>
              <span className="signer-hint-reason">Any wallet can execute now. It pays the gas.</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSigned(['Ledger'])}>
              Start over
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

const SWAP_CHECKS = [
  'Calls the pinned SODAX contract',
  'Sender and receiver are this Safe',
  'Tokens, amount and minimum output match your request',
  'No fee, solver or hook data',
]

export const SwapDemo = () => {
  const [text, setText] = useState('250')
  const amount = parseAmount(text)
  const receive = amount * STABLE_RATE
  return (
    <div className="landing-demo">
      <Sticker>Try a swap</Sticker>
      <Card title="Swap" actions={<Badge>Example quote</Badge>}>
        <div className="swap">
          <label className="swap-box">
            <span className="swap-box-head">You pay</span>
            <span className="swap-box-row">
              <input
                className={`swap-amount ${amount ? '' : 'is-empty'}`}
                inputMode="decimal"
                value={text}
                placeholder="0"
                onChange={(event) => setText(event.target.value)}
                aria-label="Amount of USDC to swap"
              />
              <span className="token-select">
                <TokenIcon symbol="USDC" />
                <strong>USDC</strong>
              </span>
            </span>
          </label>
          <div className="swap-box is-receive">
            <span className="swap-box-head">You receive</span>
            <span className="swap-box-row">
              <span className={`swap-amount ${amount ? '' : 'is-empty'}`}>{amount ? formatDemo(receive) : '0'}</span>
              <span className="token-select">
                <TokenIcon symbol="USDT" />
                <strong>USDT</strong>
              </span>
            </span>
          </div>
        </div>
        <ul className="checks">
          {SWAP_CHECKS.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

const EXAMPLE_APY = 0.052

export const EarnDemo = () => {
  const [text, setText] = useState('5000')
  const amount = parseAmount(text)
  const yearly = amount * EXAMPLE_APY
  return (
    <div className="landing-demo">
      <Sticker>Watch it grow</Sticker>
      <Card title="Earn on USDC" actions={<Badge tone={amount ? 'good' : 'neutral'}>{amount ? 'Earning' : 'Idle'}</Badge>}>
        <label className="swap-box">
          <span className="swap-box-head">You supply</span>
          <span className="swap-box-row">
            <input
              className={`swap-amount ${amount ? '' : 'is-empty'}`}
              inputMode="decimal"
              value={text}
              placeholder="0"
              onChange={(event) => setText(event.target.value)}
              aria-label="Amount of USDC to supply"
            />
            <span className="token-select">
              <TokenIcon symbol="USDC" />
              <strong>USDC</strong>
            </span>
          </span>
        </label>
        <div className="landing-earn">
          <div>
            <span className="muted small">Supply rate</span>
            <strong>{(EXAMPLE_APY * 100).toFixed(1)}% APY</strong>
          </div>
          <div>
            <span className="muted small">In a year</span>
            <strong className="text-good">+{formatDemo(yearly)} USDC</strong>
          </div>
          <div>
            <span className="muted small">Per month</span>
            <strong className="text-good">+{formatDemo(yearly / 12)} USDC</strong>
          </div>
        </div>
        <p className="muted small">Example rate. Live rates come from SODAX; your position is read onchain. Withdraw any time.</p>
      </Card>
    </div>
  )
}
