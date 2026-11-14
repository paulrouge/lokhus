import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { CollectionName } from '@msa/core'
import {
  addPasskey,
  deleteAccount,
  downloadBackup,
  keyStatus,
  saveRecoveryWallets,
  listPasskeys,
  type KeyStatus,
  type PasskeyUse,
  removePasskey,
  renameAccount,
  renamePasskey,
  signOutEverywhere,
  useAuth,
  type PasskeyInfo,
} from '../lib/auth.ts'
import { Button, Card, ErrorNote, Field } from '../components/ui.tsx'
import { AddressListInput } from '../components/AddressListInput.tsx'
import { ChainSettings } from './Chains.tsx'
import { errorMessage, timeAgo } from '../lib/format.ts'
import {
  MIN_PASSPHRASE,
  autoLockMinutes,
  forgetVault,
  lockVault,
  protectPasskey,
  regenerateRecoveryCode,
  rememberOnDevice,
  setAutoLockMinutes,
  setRememberOnDevice,
  vaultKeys,
} from '../lib/vault.ts'
import { decryptDoc, isEncrypted } from '../crypto/keys.ts'
import { RecoveryCodeNotice } from '../components/VaultGate.tsx'

const saveFile = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click()
  URL.revokeObjectURL(url)
}

const PasskeyRow = ({ passkey, onlyOne, onChange }: { passkey: PasskeyInfo; onlyOne: boolean; onChange(): void }) => {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(passkey.name)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setError(null)
    try {
      await renamePasskey(passkey.id, name)
      setEditing(false)
      onChange()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const remove = async () => {
    if (!window.confirm(`Remove the passkey "${passkey.name}"? You can no longer sign in with it.`)) return
    setError(null)
    try {
      await removePasskey(passkey.id)
      onChange()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <li className="passkey-row">
      {editing ? (
        <form
          className="row gap-sm passkey-edit"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus aria-label="Passkey name" />
          <Button size="sm" type="submit" variant="primary" disabled={!name.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="passkey-info">
          <strong>{passkey.name}</strong>
          <span className="muted small">
            Added {timeAgo(passkey.createdAt)}, last used {passkey.lastUsedAt ? timeAgo(passkey.lastUsedAt) : 'never'}
          </span>
        </div>
      )}
      {!editing && (
        <div className="row gap-sm">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" disabled={onlyOne} title={onlyOne ? 'Add another passkey first' : undefined} onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      )}
      <ErrorNote error={error} />
    </li>
  )
}

const AccountSettings = () => {
  const status = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState(status?.account?.name ?? '')
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([])
  const [busy, setBusy] = useState<'name' | 'add' | 'everywhere' | 'protect' | null>(null)
  const [unprotected, setUnprotected] = useState<PasskeyUse | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    listPasskeys()
      .then(setPasskeys)
      .catch((cause: unknown) => setError(errorMessage(cause)))

  useEffect(() => {
    void load()
  }, [])

  const run = async (kind: 'name' | 'add' | 'everywhere' | 'protect', action: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    setSaved(false)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section id="account" className="stack gap-md settings-section">
      <div className="settings-section-head">
        <div>
          <h2>Account</h2>
          <p className="muted">How you sign in to Lokhus. Your signer keys are separate and never stored here.</p>
        </div>
      </div>

      <Card title="Name">
        <form
          className="row gap-sm wrap settings-inline"
          onSubmit={(event) => {
            event.preventDefault()
            void run('name', async () => {
              await renameAccount(name)
              setSaved(true)
            })
          }}
        >
          <Field label="Account name">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
          </Field>
          <Button type="submit" busy={busy === 'name'} disabled={!name.trim() || name.trim() === status?.account?.name}>
            Save name
          </Button>
          {saved && <span className="muted small">Saved</span>}
        </form>
      </Card>

      <Card
        title="Passkeys"
        subtitle={
          passkeys.length === 1
            ? 'You have one passkey. Add a second one, on another device or a security key, so losing a device does not lock you out.'
            : 'Any of these can sign you in.'
        }
        actions={
          <Button busy={busy === 'add'} onClick={() => void run('add', async () => {
            const used = await addPasskey()
            await load()
            if (used.prf) await protectPasskey(used)
            else setUnprotected(used)
          })}>
            Add passkey
          </Button>
        }
      >
        <ul className="passkey-list">
          {passkeys.map((passkey) => (
            <PasskeyRow key={passkey.id} passkey={passkey} onlyOne={passkeys.length === 1} onChange={() => void load()} />
          ))}
        </ul>
        {unprotected && (
          <form
            className="stack gap-sm"
            onSubmit={(event) => {
              event.preventDefault()
              void run('protect', async () => {
                await protectPasskey(unprotected, passphrase)
                setUnprotected(null)
                setPassphrase('')
              })
            }}
          >
            <p className="muted">
              The new passkey cannot unlock encrypted data by itself. Choose a passphrase for it; you will enter it when you sign in with
              this passkey.
            </p>
            <div className="row gap-sm wrap settings-inline">
              <Field label="Passphrase for the new passkey">
                <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={MIN_PASSPHRASE} />
              </Field>
              <Button type="submit" busy={busy === 'protect'} disabled={passphrase.length < MIN_PASSPHRASE}>
                Save passphrase
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Card title="Sessions" subtitle="Signs out this browser and every other place you are signed in.">
        <div>
          <Button
            variant="danger"
            busy={busy === 'everywhere'}
            onClick={() =>
              void run('everywhere', async () => {
                await forgetVault()
                await signOutEverywhere()
                navigate('/welcome')
              })
            }
          >
            Sign out everywhere
          </Button>
        </div>
      </Card>
      <ErrorNote error={error} />
    </section>
  )
}


const AUTOLOCK_CHOICES = [
  { value: 0, label: 'Never' },
  { value: 15, label: 'After 15 minutes idle' },
  { value: 60, label: 'After 1 hour idle' },
  { value: 480, label: 'After 8 hours idle' },
]

const EncryptionSettings = () => {
  const [remember, setRemember] = useState(rememberOnDevice())
  const [autoLock, setAutoLock] = useState(autoLockMinutes())
  const [error, setError] = useState<string | null>(null)
  return (
    <Card
      title="Encryption"
      subtitle="Everything you store in Lokhus is encrypted in this browser before it is sent. The server only keeps ciphertext and cannot read it."
    >
      <div className="stack gap-md">
        <label className="row gap-sm check-row">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => {
              const next = event.target.checked
              setRemember(next)
              setRememberOnDevice(next).catch((cause: unknown) => setError(errorMessage(cause)))
            }}
          />
          <span>Stay unlocked on this device after a reload. Signing out always locks it.</span>
        </label>
        <Field label="Lock automatically">
          <select
            value={autoLock}
            onChange={(event) => {
              const next = Number(event.target.value)
              setAutoLock(next)
              setAutoLockMinutes(next)
            }}
          >
            {AUTOLOCK_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <Button onClick={() => void lockVault()}>Lock now</Button>
        </div>
        <ErrorNote error={error} />
      </div>
    </Card>
  )
}

const RecoverySettings = () => {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [addresses, setAddresses] = useState<string[]>([])
  const [threshold, setThreshold] = useState('1')
  const [busy, setBusy] = useState<'code' | 'wallets' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = () =>
    keyStatus()
      .then((next) => {
        setStatus(next)
        setAddresses(next.wallets?.addresses ?? [])
        setThreshold(String(next.wallets?.threshold ?? 1))
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))

  useEffect(() => {
    void load()
  }, [])

  const run = async (kind: 'code' | 'wallets', action: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    setSaved(false)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section id="recovery" className="stack gap-md settings-section">
      <div className="settings-section-head">
        <div>
          <h2>Recovery</h2>
          <p className="muted">How you get back in if you lose your passkeys.</p>
        </div>
      </div>
      <Card
        title="Recovery code"
        subtitle={
          status?.hasRecoveryCode
            ? 'Your recovery code unlocks your account and your encrypted data. Creating a new one makes the old one stop working.'
            : 'You have no recovery code yet. Create one now; without it, losing your passkeys means losing your data.'
        }
      >
        {code ? (
          <RecoveryCodeNotice code={code} action="Done" onDone={() => setCode(null)} />
        ) : (
          <div>
            <Button
              busy={busy === 'code'}
              onClick={() =>
                void run('code', async () => {
                  setCode(await regenerateRecoveryCode())
                  await load()
                })
              }
            >
              {status?.hasRecoveryCode ? 'Create a new recovery code' : 'Create a recovery code'}
            </Button>
          </div>
        )}
      </Card>
      <Card
        title="Recovery wallets"
        subtitle="Pick wallets you own, for example your Ledger and your phone wallet, and how many must sign. Together they can give you back access with a new passkey. Your data then still needs the recovery code."
      >
        <form
          className="stack gap-sm"
          onSubmit={(event) => {
            event.preventDefault()
            void run('wallets', async () => {
              await saveRecoveryWallets(addresses.length ? addresses : null, Number(threshold))
              await load()
              setSaved(true)
            })
          }}
        >
          <Field label="Wallet addresses">
            <AddressListInput value={addresses} onChange={setAddresses} />
          </Field>
          <div className="row gap-sm wrap settings-inline">
            <Field label="Signatures needed">
              <input type="number" min={1} max={Math.max(1, addresses.length)} value={threshold} onChange={(event) => setThreshold(event.target.value)} />
            </Field>
            <Button type="submit" busy={busy === 'wallets'} disabled={!addresses.length && !status?.wallets}>
              {addresses.length || !status?.wallets ? 'Save recovery wallets' : 'Remove recovery wallets'}
            </Button>
            {saved && <span className="muted small">Saved</span>}
          </div>
        </form>
      </Card>
      <ErrorNote error={error} />
    </section>
  )
}

const DataSettings = () => {
  const status = useAuth()
  const navigate = useNavigate()
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState<'plain' | 'encrypted' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: 'plain' | 'encrypted' | 'delete', action: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const stamp = new Date().toISOString().slice(0, 10)

  const exportReadable = async () => {
    const backup = await downloadBackup()
    const keys = vaultKeys()
    if (!keys) throw new Error('Unlock your data first')
    const grouped: Record<string, unknown[]> = {}
    for (const entry of backup.docs) {
      const doc = isEncrypted(entry.data) ? await decryptDoc(keys, entry.collection as CollectionName, entry.data) : entry.data
      ;(grouped[entry.collection] ??= []).push(doc)
    }
    saveFile(`lokhus-${stamp}.json`, { format: 'lokhus-export-1', exportedAt: backup.exportedAt, account: backup.account.name, data: grouped })
  }

  return (
    <section id="data" className="stack gap-md settings-section">
      <div className="settings-section-head">
        <div>
          <h2>Your data</h2>
          <p className="muted">Take your data with you, or remove it from Lokhus.</p>
        </div>
      </div>
      <Card title="Export" subtitle="The readable export contains your notes and labels in plain text; store it like a password file.">
        <div className="row gap-sm wrap">
          <Button busy={busy === 'plain'} onClick={() => void run('plain', exportReadable)}>
            Download readable export
          </Button>
          <Button busy={busy === 'encrypted'} onClick={() => void run('encrypted', async () => saveFile(`lokhus-encrypted-${stamp}.json`, await downloadBackup()))}>
            Download encrypted backup
          </Button>
        </div>
      </Card>
      <Card
        title="Delete account"
        subtitle="Deletes your account, passkeys, recovery settings and every stored item from this server. Your Safes and funds onchain are not affected."
      >
        <form
          className="row gap-sm wrap settings-inline"
          onSubmit={(event) => {
            event.preventDefault()
            if (!window.confirm('Delete your Lokhus account and all its data? This cannot be undone.')) return
            void run('delete', async () => {
              await deleteAccount(confirmName)
              await forgetVault()
              navigate('/welcome')
            })
          }}
        >
          <Field label={`Type ${status?.account?.name ?? 'the account name'} to confirm`}>
            <input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
          </Field>
          <Button type="submit" variant="danger" busy={busy === 'delete'} disabled={confirmName !== status?.account?.name}>
            Delete account
          </Button>
        </form>
      </Card>
      <ErrorNote error={error} />
    </section>
  )
}

export const Settings = () => {
  const { hash } = useLocation()

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])

  return (
    <div className="stack gap-lg settings">
      <div className="hero">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <AccountSettings />
      <section className="stack gap-md settings-section">
        <EncryptionSettings />
      </section>
      <RecoverySettings />
      <DataSettings />
      <ChainSettings />
    </div>
  )
}
