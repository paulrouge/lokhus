import { Link } from 'react-router-dom'
import type { ComponentType } from 'react'
import { useAuth } from '../lib/auth.ts'
import { PublicShell, SourceLink } from '../components/PublicShell.tsx'
import { EarnDemo, SigningDemo, SimulationDemo, SwapDemo } from '../components/LandingDemos.tsx'

const SELF_FIRST = {
  title: 'Your data stays here',
  body: 'Safes, signers and notes live in a file on this computer. Lokhus talks to the chain directly, with no Safe server in between.',
}

const HOSTED_FIRST = {
  title: 'Your keys never leave your devices',
  body: 'Lokhus keeps your Safes, labels and notes, never a key or a seed phrase. You sign on your own wallets, and transactions go straight to the chain.',
}

const OWNERSHIP = {
  title: 'No exchange, no custodian',
  body: 'The Safe is a contract on the chain that only your keys control. Nobody in between can freeze it, lend it out or go bust with it, Lokhus included.',
}

const FEATURES: { title: string; body: string; Demo: ComponentType }[] = [
  {
    title: 'You see the result before you sign',
    body: 'Every transaction is test-run against the chain first, so you approve “the Safe sends 100 USDC to your cold wallet”, not a blob of bytes. Try a different amount.',
    Demo: SimulationDemo,
  },
  {
    title: 'Your keys, one at a time',
    body: 'Ledger, phone, card, browser wallet. Sign with one, switch, sign with the next. Lokhus tells you which key is still missing.',
    Demo: SigningDemo,
  },
  {
    title: 'Swaps you can check',
    body: 'Swap any two tokens on the Safe’s chain through SODAX. The quote is decoded in your browser and refused unless every detail matches what you asked for.',
    Demo: SwapDemo,
  },
  {
    title: 'Idle money that earns',
    body: 'Supply stablecoins and other tokens to the SODAX money market straight from the Safe. Borrowers pay interest to use the money, because they expect to earn more with it than the loan costs, and that interest goes to you. You see the rate and your position, and withdrawing takes the same keys as everything else.',
    Demo: EarnDemo,
  },
]

export const Welcome = () => {
  const status = useAuth()
  const hosted = status?.mode === 'hosted'
  const start = status && (hosted || !status.accountExists) ? 'Create your account' : 'Sign in'
  const startLink = hosted ? '/signin?new=1' : '/signin'
  const first = hosted ? HOSTED_FIRST : SELF_FIRST
  return (
    <PublicShell>

      <main>
        <section className="landing-hero">
          <h1 className="landing-title">Your long-term holdings, owned by you.</h1>
          <p className="landing-lede">
            A home for the crypto you plan to keep for months or years. Several of your own keys protect it, so losing one cannot empty
            it, and you can still swap, earn and move funds whenever you want. Lokhus is the console for that Safe:{' '}
            {hosted ? 'it shows' : 'it runs on your computer, shows'} what a transaction will do before you sign it, and walks you
            through your keys one at a time.
          </p>
          <div className="landing-actions">
            <Link to={status?.signedIn ? '/' : startLink} className="btn btn-primary btn-lg">
              {status?.signedIn ? 'Open Lokhus' : start}
            </Link>
          </div>
        </section>

        <section className="landing-facts" aria-label="What Lokhus does">
          {FEATURES.map(({ title, body, Demo }) => (
            <div key={title} className="landing-fact">
              <div className="stack gap-sm">
                <h2>{title}</h2>
                <p>{body}</p>
              </div>
              <Demo />
            </div>
          ))}
          <div className="landing-fact">
            <h2>{OWNERSHIP.title}</h2>
            <p>{OWNERSHIP.body}</p>
          </div>
          <div className="landing-fact">
            <h2>{first.title}</h2>
            <p>{first.body}</p>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        Safe 1.3.0 and 1.4.1 on Polygon, Sonic, Base and Ethereum. Swaps and lending through SODAX, checked onchain. Lokhus is an independent project, not made or endorsed by SODAX, Safe or Robinhood.{' '}
        <Link to="/trust">How Lokhus can fail, and what we do about it</Link>.
        <SourceLink />
      </footer>
    </PublicShell>
  )
}
