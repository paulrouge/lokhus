import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ELIGIBILITY } from '@msa/core'
import { confirmEligibility, signOut } from '../lib/auth.ts'
import { errorMessage } from '../lib/format.ts'
import { Button, ErrorNote } from './ui.tsx'
import { Screen } from './VaultGate.tsx'

export const EligibilityCheck = ({ checked, onChange }: { checked: boolean; onChange(checked: boolean): void }) => (
  <label className="row gap-sm check-row">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} required />
    <span>{ELIGIBILITY.statement}</span>
  </label>
)

export const RegionBlockedNotice = () => (
  <>
    <p className="signin-lede">
      Lokhus is not available in your region. It is not offered to US persons or to anyone in the United States, Cuba, Iran,
      North Korea or Syria.
    </p>
    <p className="signin-note">
      Your Safe and your funds live onchain and do not depend on Lokhus. You can keep using them with any other Safe app.
    </p>
  </>
)

export const RegionBlocked = () => (
  <Screen title="Not available here">
    <RegionBlockedNotice />
  </Screen>
)

export const EligibilityGate = () => {
  const navigate = useNavigate()
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <Screen title="One confirmation first" lede="Lokhus is not offered to US persons or in restricted countries. Confirm this once to continue.">
      <form
        className="stack gap-md"
        onSubmit={(event) => {
          event.preventDefault()
          void run(confirmEligibility)
        }}
      >
        <EligibilityCheck checked={checked} onChange={setChecked} />
        <ErrorNote error={error} />
        <div className="landing-actions">
          <Button type="submit" variant="primary" className="btn-lg" busy={busy} disabled={!checked}>
            Confirm and continue
          </Button>
        </div>
      </form>
      <p className="signin-note">
        If this does not apply to you,{' '}
        <button
          type="button"
          className="link-button"
          onClick={() =>
            void run(async () => {
              await signOut()
              navigate('/welcome')
            })
          }
        >
          sign out
        </button>
        .
      </p>
    </Screen>
  )
}
