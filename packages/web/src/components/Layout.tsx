import { forgetVault, lockVault } from '../lib/vault.ts'
import { useState, type ReactNode } from 'react'
import { NavLink, Link, useNavigate } from 'react-router-dom'
import { signOut, useAuth } from '../lib/auth.ts'
import { useWallet } from '../state/wallet.tsx'
import { useOwnerLabels } from '../state/data.tsx'
import { Avatar, Button } from './ui.tsx'
import { WalletModal } from './WalletModal.tsx'
import { shortAddress } from '../lib/format.ts'

const WalletButton = () => {
  const { connection, openConnect, disconnect, plugins } = useWallet()
  const owners = useOwnerLabels()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!connection) {
    return (
      <Button variant="primary" size="sm" onClick={() => openConnect()}>
        Connect signer
      </Button>
    )
  }

  const owner = owners.get(connection.address.toLowerCase())
  const plugin = plugins.find((candidate) => candidate.id === connection.pluginId)

  return (
    <div className="wallet-button">
      <button className="wallet-chip" onClick={() => setMenuOpen((open) => !open)}>
        <Avatar address={connection.address} size={22} />
        <span>{owner?.label ?? shortAddress(connection.address)}</span>
        <span className="muted small">{owner?.connectedVia ?? plugin?.label}</span>
      </button>
      {menuOpen && (
        <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
          <span className="mono small muted">{connection.address}</span>
          <Button
            size="sm"
            onClick={() => {
              setMenuOpen(false)
              openConnect()
            }}
          >
            Switch signer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMenuOpen(false)
              void disconnect()
            }}
          >
            Disconnect
          </Button>
        </div>
      )}
    </div>
  )
}

const AccountMenu = () => {
  const status = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <div className="wallet-button">
      <button className="account-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="account-initial" aria-hidden="true">
          {(status?.account?.name ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span>{status?.account?.name ?? 'Account'}</span>
      </button>
      {open && (
        <div className="menu account-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <Link to="/settings" role="menuitem" className="menu-link" onClick={() => setOpen(false)}>
            Settings
          </Link>
          <button
            role="menuitem"
            className="menu-link"
            onClick={() => {
              setOpen(false)
              void lockVault()
            }}
          >
            Lock
          </button>
          <button
            role="menuitem"
            className="menu-link"
            onClick={() => {
              setOpen(false)
              void forgetVault()
                .then(signOut)
                .then(() => navigate('/welcome'))
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export const Layout = ({ children }: { children: ReactNode }) => (
  <div className="app">
    <header className="topbar">
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" />
        <span>Lokhus</span>
      </Link>
      <nav className="nav">
        <NavLink to="/" end>
          Safes
        </NavLink>
        <NavLink to="/owners">Signers</NavLink>
        <NavLink to="/notebook">Notebook</NavLink>
        <NavLink to="/best-practice">Best practice</NavLink>
        <NavLink to="/security">Security</NavLink>
      </nav>
      <WalletButton />
      <AccountMenu />
    </header>
    <main className="page">{children}</main>
    <WalletModal />
  </div>
)
