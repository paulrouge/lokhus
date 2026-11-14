import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { keyStatus, markMigrated, resetEncryptedData, signOut, takeLastPasskey, promptPasskey, type PasskeyUse } from '../lib/auth.ts'
import {
  MIN_PASSPHRASE,
  checkIdle,
  createVault,
  forgetVault,
  isUnlockedFor,
  noteActivity,
  plaintextImportDone,
  plaintextImportDueFor,
  protectPasskey,
  restoreFromDevice,
  unlockWithPasskey,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  useVault,
  vaultKeys,
  type UnlockOutcome,
} from '../lib/vault.ts'
import { encryptPlaintextDocs } from '../crypto/encryptedStorage.ts'
import type { HttpStorage } from '../storage/httpStorage.ts'
import { Button, ErrorNote } from './ui.tsx'
import { errorMessage } from '../lib/format.ts'

type Stage =
  | { kind: 'checking' }
  | { kind: 'locked' }
  | { kind: 'setup'; used: PasskeyUse }
  | { kind: 'code'; code: string }
  | { kind: 'passphrase'; passkeyId: string }
  | { kind: 'no-key'; used: PasskeyUse }
  | { kind: 'migrating'; done: number }
  | { kind: 'ready' }

const Screen = ({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) => (
  <div className="landing landing-signin">
    <header className="landing-bar">
      <span className="landing-brand">
        <img src="/favicon.svg" alt="" />
        Lokhus
      </span>
    </header>
    <main className="signin" aria-live="polite">
      <h1 className="signin-title">{title}</h1>
      {lede && <p className="signin-lede">{lede}</p>}
      {children}
    </main>
  </div>
)

export const RecoveryCodeNotice = ({ code, onDone, action = 'Continue' }: { code: string; onDone(): void; action?: string }) => {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const download = () => {
    const blob = new Blob([`Lokhus recovery code\n\n${code}\n\nKeep this somewhere safe and offline. Anyone with it can open your Lokhus data.\n`], {
      type: 'text/plain',
    })
    const url = URL.createObjectURL(blob)
    const link = Object.assign(document.createElement('a'), { href: url, download: 'lokhus-recovery-code.txt' })
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="stack gap-md">
      <p className="recovery-code" aria-label="Recovery code">
        {code}
      </p>
      <div className="row gap-sm wrap">
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
            })
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" onClick={download}>
          Download as a file
        </Button>
      </div>
      <label className="row gap-sm check-row">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        <span>I stored this code somewhere safe, away from this device.</span>
      </label>
      <div className="landing-actions">
        <Button variant="primary" className="btn-lg" disabled={!saved} onClick={onDone}>
          {action}
        </Button>
      </div>
    </div>
  )
}

export const VaultGate = ({ accountId, raw, children }: { accountId: string; raw: HttpStorage; children: ReactNode }) => {
  const navigate = useNavigate()
  const vault = useVault()
  const [stage, setStage] = useState<Stage>({ kind: 'checking' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [code, setCode] = useState('')
  const started = useRef(false)

  const afterUnlock = async () => {
    const status = await keyStatus()
    if (!status.migrated && plaintextImportDueFor(accountId)) {
      setStage({ kind: 'migrating', done: 0 })
      await encryptPlaintextDocs(raw, vaultKeys()!, {
        onProgress: (done) => setStage({ kind: 'migrating', done }),
        removePlaintext: raw.removePlaintext,
      })
      await markMigrated()
      plaintextImportDone()
    }
    setStage({ kind: 'ready' })
  }

  const handle = async (outcome: UnlockOutcome, used: PasskeyUse) => {
    if (outcome.kind === 'unlocked') return afterUnlock()
    if (outcome.kind === 'setup') return setStage({ kind: 'setup', used })
    if (outcome.kind === 'passphrase') return setStage({ kind: 'passphrase', passkeyId: outcome.passkeyId })
    setStage({ kind: 'no-key', used: { passkeyId: outcome.passkeyId, prf: outcome.prf } })
  }

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

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        if (isUnlockedFor(accountId)) return await afterUnlock()
        const used = takeLastPasskey()
        if (used) return await handle(await unlockWithPasskey(accountId, used), used)
        if (await restoreFromDevice(accountId)) return await afterUnlock()
        setStage({ kind: 'locked' })
      } catch (cause) {
        setError(errorMessage(cause))
        setStage({ kind: 'locked' })
      }
    })()
  }, [accountId])

  useEffect(() => {
    if (stage.kind === 'ready' && !vault.unlocked) setStage({ kind: 'locked' })
  }, [stage.kind, vault.unlocked])

  useEffect(() => {
    if (stage.kind !== 'ready') return
    let last = 0
    const active = () => {
      if (Date.now() - last < 20_000) return
      last = Date.now()
      noteActivity()
    }
    const events = ['pointerdown', 'keydown', 'scroll'] as const
    events.forEach((name) => window.addEventListener(name, active, { passive: true }))
    const timer = setInterval(checkIdle, 30_000)
    return () => {
      events.forEach((name) => window.removeEventListener(name, active))
      clearInterval(timer)
    }
  }, [stage.kind])

  const leave = () =>
    void run(async () => {
      await forgetVault()
      await signOut()
      navigate('/welcome')
    })

  const signOutLink = (
    <p className="signin-note">
      Not you?{' '}
      <button type="button" className="link-button" onClick={leave}>
        Sign out
      </button>
    </p>
  )

  if (stage.kind === 'ready') return <>{children}</>

  if (stage.kind === 'checking') return <Screen title="Unlocking…" />

  if (stage.kind === 'migrating')
    return (
      <Screen
        title="Encrypting your data"
        lede="Lokhus now encrypts everything in your browser before it is stored. This runs once and takes a moment."
      >
        <p className="muted">
          {stage.done.toLocaleString('en')} items encrypted so far. Keep this tab open. Activity history is not copied; it reloads from
          the chain when you open a Safe.
        </p>
      </Screen>
    )

  if (stage.kind === 'code')
    return (
      <Screen
        title="Save your recovery code"
        lede="Your data is encrypted with a key only your passkeys and this code can open. If you lose every passkey, this code is the only way back in. Lokhus cannot recover it for you."
      >
        <RecoveryCodeNotice code={stage.code} onDone={() => void run(afterUnlock)} />
      </Screen>
    )

  if (stage.kind === 'setup')
    return (
      <Screen
        title="Protect your data"
        lede={
          stage.used.prf
            ? 'Lokhus will create a key in this browser that encrypts your data before it is stored. Only your passkeys and a recovery code can open it.'
            : 'This passkey cannot unlock encrypted data by itself. Choose a passphrase for it. You will enter it when you sign in with this passkey.'
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => setStage({ kind: 'code', code: await createVault(accountId, stage.used, passphrase || undefined) }))
          }}
        >
          {!stage.used.prf && (
            <label className="signin-field">
              <span>Passphrase for this passkey</span>
              <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={MIN_PASSPHRASE} autoFocus />
            </label>
          )}
          <ErrorNote error={error} />
          <div className="landing-actions">
            <Button type="submit" variant="primary" className="btn-lg" busy={busy} disabled={!stage.used.prf && passphrase.length < MIN_PASSPHRASE}>
              Encrypt my data
            </Button>
          </div>
        </form>
        {signOutLink}
      </Screen>
    )

  if (stage.kind === 'passphrase')
    return (
      <Screen title="Enter your passphrase" lede="This passkey unlocks your data together with the passphrase you chose for it.">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await unlockWithPassphrase(accountId, stage.passkeyId, passphrase)
              setPassphrase('')
              await afterUnlock()
            })
          }}
        >
          <label className="signin-field">
            <span>Passphrase</span>
            <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoFocus />
          </label>
          <ErrorNote error={error} />
          <div className="landing-actions">
            <Button type="submit" variant="primary" className="btn-lg" busy={busy} disabled={!passphrase}>
              Unlock
            </Button>
          </div>
        </form>
        {signOutLink}
      </Screen>
    )

  if (stage.kind === 'no-key')
    return (
      <Screen
        title="Unlock with your recovery code"
        lede="This passkey cannot open your data yet. Enter your recovery code once, and Lokhus will let this passkey unlock it from now on."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await unlockWithRecoveryCode(accountId, code)
              await protectPasskey(stage.used, passphrase || undefined)
              setCode('')
              setPassphrase('')
              await afterUnlock()
            })
          }}
        >
          <label className="signin-field">
            <span>Recovery code</span>
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCDE-FGHJK-MNPQR-STVWX-YZ012" autoFocus />
          </label>
          {!stage.used.prf && (
            <label className="signin-field">
              <span>New passphrase for this passkey</span>
              <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={MIN_PASSPHRASE} />
            </label>
          )}
          <ErrorNote error={error} />
          <div className="landing-actions">
            <Button
              type="submit"
              variant="primary"
              className="btn-lg"
              busy={busy}
              disabled={!code.trim() || (!stage.used.prf && passphrase.length < MIN_PASSPHRASE)}
            >
              Unlock
            </Button>
          </div>
        </form>
        <details className="signin-note">
          <summary>Lost the recovery code too?</summary>
          <p>
            Without a passkey that holds your key or the recovery code, your notes, labels and history cannot be decrypted, not even by
            Lokhus. You can start over with an empty account and import your Safes again from the chain; their funds are not affected.
          </p>
          <Button
            variant="danger"
            size="sm"
            busy={busy}
            onClick={() => {
              if (!window.confirm('Delete all encrypted data in this account and start over? This cannot be undone.')) return
              void run(async () => {
                await resetEncryptedData()
                setStage({ kind: 'setup', used: stage.used })
              })
            }}
          >
            Start over with an empty account
          </Button>
        </details>
        {signOutLink}
      </Screen>
    )

  return (
    <Screen title="Your data is locked" lede="Unlock it with your passkey. Lokhus keeps your data encrypted until you do.">
      <ErrorNote error={error} />
      <div className="landing-actions">
        <Button
          variant="primary"
          className="btn-lg"
          busy={busy}
          onClick={() =>
            void run(async () => {
              const used = await promptPasskey()
              await handle(await unlockWithPasskey(accountId, used), used)
            })
          }
        >
          Unlock with passkey
        </Button>
      </div>
      {signOutLink}
    </Screen>
  )
}
