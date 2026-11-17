import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createWalletClient, custom } from 'viem'
import { DEFAULT_CHAINS, type CollectionMap, type CollectionName, type Storage } from '@msa/core'
import {
  currentAuth,
  findRecoveryCode,
  recoverWithWallets,
  registerRecoveryPasskey,
  takeLastPasskey,
  useAuth,
  walletRecoveryChallenge,
  type PasskeyUse,
} from '../lib/auth.ts'
import { MIN_PASSPHRASE, protectPasskey, unlockWithRecoveryCode } from '../lib/vault.ts'
import { recoveryParts } from '../crypto/keys.ts'
import { DataProvider } from '../state/data.tsx'
import { WalletProvider, useWallet } from '../state/wallet.tsx'
import { WalletModal } from '../components/WalletModal.tsx'
import { RegionBlockedNotice } from '../components/Eligibility.tsx'
import { Button, ErrorNote } from '../components/ui.tsx'
import { errorMessage, shortAddress } from '../lib/format.ts'

const memoryStorage = (): Storage => {
  const data = new Map<CollectionName, Map<string, { id: string }>>([['chains', new Map(DEFAULT_CHAINS.map((chain) => [chain.id, chain]))]])
  const table = (collection: CollectionName) => data.get(collection) ?? data.set(collection, new Map()).get(collection)!
  return {
    list: async (collection) => [...table(collection).values()] as never,
    page: async (collection) => ({ items: [...table(collection).values()] as never, nextCursor: null }),
    get: async (collection, id) => (table(collection).get(id) ?? null) as CollectionMap[typeof collection] | null,
    put: async (collection, item) => {
      table(collection).set(item.id, item)
      return item
    },
    remove: async (collection, id) => {
      table(collection).delete(id)
    },
  }
}

const useRunner = () => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  return { busy, error, run }
}

const EXISTING_PASSKEY = 'This device already has a passkey for this account. Confirm with it to finish recovery.'

const CodeRecovery = () => {
  const navigate = useNavigate()
  const { busy, error, run } = useRunner()
  const [notice, setNotice] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [pending, setPending] = useState<{ used: PasskeyUse; accountId: string } | null>(null)

  const finish = async (used: PasskeyUse, accountId: string) => {
    await protectPasskey(used, passphrase || undefined)
    takeLastPasskey()
    navigate('/', { replace: true })
  }

  if (pending)
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => finish(pending.used, pending.accountId))
        }}
      >
        <p className="signin-lede">Your new passkey cannot unlock data by itself. Choose a passphrase for it.</p>
        <label className="signin-field">
          <span>Passphrase for this passkey</span>
          <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={MIN_PASSPHRASE} autoFocus />
        </label>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" className="btn-lg" busy={busy} disabled={passphrase.length < MIN_PASSPHRASE}>
          Finish
        </Button>
      </form>
    )

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const { authSecret } = await recoveryParts(code)
          const found = await findRecoveryCode(authSecret)
          const used = await registerRecoveryPasskey(found.grant, () => setNotice(EXISTING_PASSKEY))
          const accountId = currentAuth()?.account?.id
          if (!accountId) throw new Error('Signing in after recovery failed. Try again.')
          await unlockWithRecoveryCode(accountId, code, found.locked)
          setCode('')
          if (used.prf) await finish(used, accountId)
          else setPending({ used, accountId })
        })
      }}
    >
      <p className="signin-lede">
        Enter the recovery code you saved when you created your account. You will create a new passkey, and your data unlocks with it.
      </p>
      <label className="signin-field">
        <span>Recovery code</span>
        <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCDE-FGHJK-MNPQR-STVWX-YZ012" autoFocus />
      </label>
      {notice && <p className="signin-note">{notice}</p>}
      <ErrorNote error={error} />
      <div className="landing-actions">
        <Button type="submit" variant="primary" className="btn-lg" busy={busy} disabled={!code.trim()}>
          Recover and create a passkey
        </Button>
      </div>
    </form>
  )
}

const WalletRecovery = () => {
  const navigate = useNavigate()
  const { connection, openConnect, disconnect } = useWallet()
  const { busy, error, run } = useRunner()
  const [challenge, setChallenge] = useState<{ challenge: string; message: string } | null>(null)
  const [signatures, setSignatures] = useState<{ address: string; signature: string }[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void run(async () => setChallenge(await walletRecoveryChallenge()))
  }, [])

  const sign = () =>
    run(async () => {
      if (!connection || !challenge) return
      const client = createWalletClient({ account: connection.address, transport: custom(connection.provider) })
      const signature = await client.signMessage({ account: connection.address, message: challenge.message })
      setSignatures((previous) => [
        ...previous.filter((entry) => entry.address.toLowerCase() !== connection.address.toLowerCase()),
        { address: connection.address, signature },
      ])
      await disconnect()
    })

  const recover = () =>
    run(async () => {
      if (!challenge) return
      const found = await recoverWithWallets(
        challenge.challenge,
        signatures.map((entry) => entry.signature),
      )
      await registerRecoveryPasskey(found.grant, () => setNotice(EXISTING_PASSKEY))
      navigate('/', { replace: true })
    })

  return (
    <div className="stack gap-md">
      <p className="signin-lede">
        Sign a short message with enough of the recovery wallets you chose in Settings. This only proves you hold them; it moves no
        funds. It gives you back access, but your data stays locked until you also enter your recovery code.
      </p>
      {challenge && <pre className="signin-message">{challenge.message}</pre>}
      {signatures.length > 0 && (
        <ul className="stack gap-xs">
          {signatures.map((entry) => (
            <li key={entry.address} className="muted">
              Signed by {shortAddress(entry.address)}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="signin-note">{notice}</p>}
      <ErrorNote error={error} />
      <div className="landing-actions">
        {connection ? (
          <Button variant="primary" className="btn-lg" busy={busy} onClick={() => void sign()}>
            Sign with {shortAddress(connection.address)}
          </Button>
        ) : (
          <Button variant={signatures.length ? 'secondary' : 'primary'} className="btn-lg" disabled={!challenge} onClick={() => openConnect()}>
            {signatures.length ? 'Sign with another wallet' : 'Connect a recovery wallet'}
          </Button>
        )}
        {signatures.length > 0 && !connection && (
          <Button variant="primary" className="btn-lg" busy={busy} onClick={() => void recover()}>
            Recover and create a passkey
          </Button>
        )}
      </div>
    </div>
  )
}

export const Recover = () => {
  const status = useAuth()
  const storage = useMemo(memoryStorage, [])
  const [method, setMethod] = useState<'code' | 'wallets'>('code')
  return (
    <DataProvider storage={storage}>
      <WalletProvider>
        <div className="landing landing-signin">
          <header className="landing-bar">
            <Link to="/welcome" className="landing-brand">
              <img src="/favicon.svg" alt="" />
              Lokhus
            </Link>
          </header>
          <main className="signin">
            <h1 className="signin-title">{status?.regionBlocked ? 'Not available here' : 'Recover your account'}</h1>
            {status?.regionBlocked ? (
              <RegionBlockedNotice />
            ) : (
              <>
                <div className="segmented" role="tablist" aria-label="Recovery method">
                  <button type="button" role="tab" aria-selected={method === 'code'} className={method === 'code' ? 'active' : ''} onClick={() => setMethod('code')}>
                    Recovery code
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={method === 'wallets'}
                    className={method === 'wallets' ? 'active' : ''}
                    onClick={() => setMethod('wallets')}
                  >
                    Recovery wallets
                  </button>
                </div>
                {method === 'code' ? <CodeRecovery /> : <WalletRecovery />}
              </>
            )}
            <p className="signin-note">
              Remembered your passkey? <Link to="/signin" className="link">Sign in</Link>
            </p>
          </main>
        </div>
        <WalletModal />
      </WalletProvider>
    </DataProvider>
  )
}
