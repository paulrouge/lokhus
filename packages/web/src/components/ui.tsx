import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { keccak256, toBytes } from 'viem'
import { explorerLink, sodaxChainLogo, type ChainConfig } from '@msa/core'
import { useOwnerLabels } from '../state/data.tsx'
import { shortAddress } from '../lib/format.ts'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  busy?: boolean
}

export const Button = ({ variant = 'secondary', size = 'md', busy, disabled, children, className, ...rest }: ButtonProps) => (
  <button
    className={`btn btn-${variant} btn-${size} ${busy ? 'is-busy' : ''} ${className ?? ''}`}
    disabled={disabled || busy}
    {...rest}
  >
    {busy && <span className="spinner" />}
    {children}
  </button>
)

export const Card = ({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) => (
  <section className={`card ${className ?? ''}`}>
    {(title || actions) && (
      <header className="card-head">
        <div>
          {title && <h3>{title}</h3>}
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
    )}
    {children}
  </section>
)

export const Badge = ({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad'; children: ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
)

export const Field = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
)

export const Empty = ({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) => (
  <div className="empty">
    <div className="empty-mark" />
    <h4>{title}</h4>
    {body && <p className="muted">{body}</p>}
    {action}
  </div>
)

export const ErrorNote = ({ error }: { error?: string | null }) => (error ? <div className="error-note">{error}</div> : null)

export const Modal = ({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) => {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

const hue = (seed: string, offset: number) => parseInt(keccak256(toBytes(seed.toLowerCase())).slice(2 + offset, 6 + offset), 16) % 360

export const Avatar = ({ address, size = 28 }: { address: string; size?: number }) => (
  <span
    className="avatar"
    style={{
      width: size,
      height: size,
      background: `conic-gradient(from ${hue(address, 8)}deg, hsl(${hue(address, 0)} 70% 62%), hsl(${hue(address, 4)} 72% 54%), hsl(${hue(address, 0)} 70% 62%))`,
    }}
  />
)

export const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
)

export const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="icon-btn"
      title="Copy"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

export const AddressTag = ({
  address,
  chain,
  label,
  full,
}: {
  address: string
  chain?: ChainConfig
  label?: string
  full?: boolean
}) => {
  const owners = useOwnerLabels()
  const name = label ?? owners.get(address.toLowerCase())?.label
  return (
    <span className="address-tag">
      <Avatar address={address} size={22} />
      <span className="address-text">
        {name && <span className="address-name">{name}</span>}
        <span className="mono">{full ? address : shortAddress(address)}</span>
      </span>
      <CopyButton value={address} />
      {chain && (
        <a className="icon-btn" href={explorerLink(chain, 'address', address)} target="_blank" rel="noreferrer" title="Open in explorer">
          ↗
        </a>
      )}
    </span>
  )
}

export const ChainIcon = ({ chainId = 0 }: { chainId?: number }) => {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [chainId])
  const logo = sodaxChainLogo(chainId)
  return logo && !failed ? (
    <img className="chain-logo" src={logo} alt="" width={16} height={16} onError={() => setFailed(true)} />
  ) : (
    <span className="chain-dot" style={{ background: `hsl(${hue(String(chainId), 0)} 65% 50%)` }} />
  )
}

export const ChainPill = ({ chain }: { chain?: ChainConfig }) => (
  <span className="chain-pill">
    <ChainIcon chainId={chain?.chainId} />
    {chain?.name ?? 'Unknown chain'}
  </span>
)

export const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="stat">
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value}</span>
  </div>
)

export type Crumb = { label: ReactNode; to?: string }

export const Breadcrumb = ({ items, children }: { items: Crumb[]; children?: ReactNode }) => {
  const parent = [...items].reverse().find((item) => item.to)
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol className="breadcrumb-full">
        {items.map((item, index) => (
          <li key={index}>
            {item.to && index < items.length - 1 ? (
              <Link to={item.to}>{item.label}</Link>
            ) : (
              <span aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
      {parent?.to && (
        <Link to={parent.to} className="breadcrumb-back">
          ← {parent.label}
        </Link>
      )}
      {children}
    </nav>
  )
}
