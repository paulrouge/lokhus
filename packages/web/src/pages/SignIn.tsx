import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { createAccount, signIn, useAuth } from '../lib/auth.ts'
import { Button, ErrorNote } from '../components/ui.tsx'
import { errorMessage } from '../lib/format.ts'
import { ELIGIBILITY } from '@msa/core'
import { EligibilityCheck, RegionBlockedNotice } from '../components/Eligibility.tsx'

const onLoopbackAddress = () => window.location.hostname === '127.0.0.1' || window.location.hostname === '[::1]'

const WhyPasskeys = () => (
  <details className="signin-why">
    <summary>Why only passkeys?</summary>
    <p>We chose this on purpose. Your Safe guards your funds with more than one key; your account deserves the same care.</p>
    <ul>
      <li>
        <strong>Nothing to steal from us.</strong> Lokhus stores only the public half of your passkey, so a breach would leak no
        passwords.
      </li>
      <li>
        <strong>It cannot be phished.</strong> A passkey only works on the real Lokhus address. A lookalike site gets nothing,
        even if you are fooled.
      </li>
      <li>
        <strong>Nothing to guess, reuse or intercept.</strong> No password to reuse elsewhere, and no codes by email or text
        message that someone could catch.
      </li>
      <li>
        <strong>It also unlocks your private data.</strong> The same Touch ID or security key opens the key that encrypts your
        notes and labels, which stay unreadable to us.
      </li>
    </ul>
  </details>
)

export const SignIn = () => {
  const status = useAuth()
  const [params] = useSearchParams()
  const setupCode = params.get('setup')?.trim() ?? ''
  const [name, setName] = useState('')
  const [wantsAccount, setWantsAccount] = useState(params.get('new') === '1')
  const [eligible, setEligible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status?.signedIn) return <Navigate to="/" replace />

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const hosted = status?.mode === 'hosted'
  const creating = hosted ? wantsAccount : !!status?.registrationOpen && !status.accountExists
  const resetting = !!status?.awaitingPasskey
  const needsSetupLink = !!status?.registrationOpen && !!status.needsSetupCode && !setupCode

  return (
    <div className="landing landing-signin">
      <header className="landing-bar">
        <Link to="/welcome" className="landing-brand">
          <img src="/favicon.svg" alt="" />
          Lokhus
        </Link>
      </header>
      <main className="signin">
        {!status ? (
          <p className="signin-lede">Loading…</p>
        ) : status.regionBlocked ? (
          <>
            <h1 className="signin-title">Not available here</h1>
            <RegionBlockedNotice />
          </>
        ) : needsSetupLink ? (
          <>
            <h1 className="signin-title">{resetting ? 'Create a new passkey' : 'Create your account'}</h1>
            <p className="signin-lede">Open the link printed in the Lokhus server log to create your passkey.</p>
            <p className="signin-note">
              It looks like <code>http://localhost:8787/signin?setup=…</code> and appears when the server starts, or after{' '}
              <code>make reset-login</code>. It works once.
            </p>
          </>
        ) : creating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void run(() => createAccount(name, setupCode, hosted ? ELIGIBILITY.version : undefined))
            }}
          >
            <h1 className="signin-title">Create your account</h1>
            <p className="signin-lede">
              Lokhus signs you in with a passkey: Touch ID, Face ID, your phone or a security key. There is no password to
              remember or leak.{hosted ? '' : ' Anything you have already set up here moves into this account.'}
            </p>
            <label className="signin-field">
              <span>Account name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="For example, Personal" maxLength={60} required autoFocus />
            </label>
            {hosted && <EligibilityCheck checked={eligible} onChange={setEligible} />}
            <ErrorNote error={error} />
            <div className="landing-actions">
              <Button type="submit" variant="primary" className="btn-lg" busy={busy} disabled={!name.trim() || (hosted && !eligible)}>
                Create passkey
              </Button>
            </div>
            <p className="signin-note">Add a second passkey in Settings afterwards, so losing one device does not lock you out.</p>
            {hosted && (
              <p className="signin-note">
                Already have an account?{' '}
                <button type="button" className="link-button" onClick={() => setWantsAccount(false)}>
                  Sign in
                </button>
              </p>
            )}
          </form>
        ) : resetting ? (
          <>
            <h1 className="signin-title">Create a new passkey</h1>
            <p className="signin-lede">
              Sign-in was reset on this computer. Create a passkey to get back into your account. Your Safes, signers and notes
              are still here.
            </p>
            <ErrorNote error={error} />
            <div className="landing-actions">
              <Button variant="primary" className="btn-lg" busy={busy} onClick={() => void run(() => createAccount('Lokhus', setupCode))}>
                Create passkey
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="signin-title">Welcome back</h1>
            <p className="signin-lede">Sign in with the passkey you created for Lokhus.</p>
            <ErrorNote error={error} />
            <div className="landing-actions">
              <Button variant="primary" className="btn-lg" busy={busy} onClick={() => void run(signIn)}>
                Sign in with a passkey
              </Button>
            </div>
            <p className="signin-note">
              Lost your passkeys?{' '}
              <Link to="/recover" className="link">
                Recover your account
              </Link>{' '}
              with your recovery code or recovery wallets.
            </p>
            {hosted ? (
              <>
                <p className="signin-note">
                  New to Lokhus?{' '}
                  <button type="button" className="link-button" onClick={() => setWantsAccount(true)}>
                    Create an account
                  </button>
                </p>
                <p className="signin-note">Keep a second passkey in Settings, so losing one device does not lock you out.</p>
              </>
            ) : (
              <p className="signin-note">
                No recovery code either? Run <code>make reset-login</code> on the computer that runs Lokhus to create a new passkey.
                Encrypted data then still needs the recovery code.
              </p>
            )}
          </>
        )}
        {status && !status.regionBlocked && <WhyPasskeys />}
        {onLoopbackAddress() && (
          <p className="signin-note">
            Passkeys do not work on {window.location.hostname}. Open{' '}
            <a className="link" href={`http://localhost:${window.location.port}${window.location.pathname}`}>
              localhost:{window.location.port}
            </a>{' '}
            instead.
          </p>
        )}
      </main>
    </div>
  )
}
