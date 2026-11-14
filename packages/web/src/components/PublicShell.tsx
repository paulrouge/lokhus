import { useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth.ts'

export const PublicShell = ({ children }: { children: ReactNode }) => {
  const status = useAuth()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <div className="landing">
      <header className="landing-bar">
        <Link to="/welcome" className="landing-brand">
          <img src="/favicon.svg" alt="" />
          Lokhus
        </Link>
        <div className="landing-bar-end">
          <nav id="public-nav" className={`landing-nav ${open ? 'is-open' : ''}`}>
            <NavLink to="/security" onClick={close}>
              Security
            </NavLink>
            <NavLink to="/best-practice" onClick={close}>
              Best practice
            </NavLink>
            <NavLink to="/trust" onClick={close}>
              Trust
            </NavLink>
          </nav>
          <Link to={status?.signedIn ? '/' : '/signin'} className="btn btn-secondary btn-md">
            {status?.signedIn ? 'Open Lokhus' : 'Sign in'}
          </Link>
          <button
            type="button"
            className={`landing-burger ${open ? 'is-open' : ''}`}
            aria-label="Menu"
            aria-controls="public-nav"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </header>
      {children}
    </div>
  )
}
