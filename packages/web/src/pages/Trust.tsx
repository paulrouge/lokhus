import { Link } from 'react-router-dom'
import { PublicShell, SourceLink } from '../components/PublicShell.tsx'

type Risk = { title: string; risk: string; measures: string[]; gap?: string; you?: string }

const RISKS: Risk[] = [
  {
    title: 'Someone takes over lokhus.com',
    risk: 'An attacker who controls the domain can serve a fake Lokhus that asks you to sign something else.',
    measures: [
      'Domain transfer lock on.',
      'DNSSEC on, so DNS answers can’t be forged on the way to you.',
      'A CAA record lets only Let’s Encrypt issue certificates for the domain.',
      'HSTS for two years on every subdomain, so browsers never fall back to plain http.',
      'Login is passkey only. Passkeys are bound to lokhus.com, so a lookalike domain can’t use them.',
    ],
    you: 'Type the address or use a bookmark. Before signing, compare the Safe tx hash on your wallet’s screen with the one in the app.',
  },
  {
    title: 'The server is compromised',
    risk: 'Whoever controls the server controls the code your browser runs. Bad code could show you one transaction and send your wallet another, or read your data after you unlock it.',
    measures: [
      'TLS ends on our own server, not at a CDN, so no third party can change what we serve.',
      'Only ports 80 and 443 are public. Admin access goes over a private network.',
      'A strict Content Security Policy: scripts only from lokhus.com, no inline code, and the app can’t be framed.',
      'Your data is end-to-end encrypted, so a server breach alone doesn’t expose it.',
    ],
    gap: 'Open source code and published hashes of every build, so you can check that what you load is what’s in the source. Until then, you trust us to serve what we built.',
    you: 'Compare the Safe tx hash on your hardware wallet with the one you expect before you sign. That check doesn’t depend on our code.',
  },
  {
    title: 'A bad dependency gets into the build',
    risk: 'A compromised npm package ends up in the app and changes what you sign.',
    measures: [
      'Exact versions pinned in the lockfile, install scripts disabled.',
      'Dependencies added deliberately and checked with npm audit.',
      'The server has almost no dependencies: Node itself, passkeys, two pinned crypto libraries and Postgres.',
      'The Docker base image is pinned by digest.',
      'Safe transaction hashing is our own code, tested against Safe’s reference implementation.',
    ],
  },
  {
    title: 'Your data is stolen from the server',
    risk: 'Someone reads the database: your Safes, owners, notes and history.',
    measures: [
      'Everything is encrypted in your browser before it’s sent. The key is locked by your passkey and by your recovery code. We can’t read your data, and neither can anyone who steals the database.',
      'The server only sees what it needs to route data: collection names, sizes, timestamps and block numbers.',
      'Two exceptions are stored readable: the statement you sign before your first stock trade, with the signer, Safe address, chain and block it names, and the time you confirmed you are not a US person or in a restricted country. They are our record that you accepted them, and they are deleted with your account.',
      'Sessions are random, stored only as hashes, in HttpOnly, SameSite=Strict cookies.',
      'Adding passkeys, exporting and deleting the account need a fresh passkey check.',
    ],
    you: 'If you lose every passkey and your recovery code, your Lokhus data can’t be recovered by anyone, including us. That data is only labels, notes and pending signatures. Your Safe, its owners, funds and history all live onchain: import the Safe by its address, here or in any other Safe app, and you’re back. Only signatures for transactions that were never executed are lost; sign those again.',
  },
  {
    title: 'A transaction is changed before you sign it',
    risk: 'The app, a wallet bridge or a third-party API swaps in different calldata.',
    measures: [
      'Safe transaction hashes are built in your browser, and every signature is verified before it’s stored.',
      'SODAX swap and lending data is decoded locally and refused unless every field (contract, chain, amounts, recipient, deadline) matches what you asked for.',
    ],
    you: 'Read what your hardware wallet shows and compare the Safe tx hash. Avoid blind signing unless you’ve checked the hash.',
  },
  {
    title: 'A stock token loses its value',
    risk: 'Stock tokens traded through SODAX are copies of Robinhood’s onchain stock tokens. A broken backing, a bug or a failing issuer can make one stop tracking its share or lose its value.',
    measures: [
      'The Stocks action explains what you are buying and links to Robinhood’s own documentation and prospectus.',
      'On lokhus.com, before your first stock trade you sign a statement with one of your Safe’s signers that you understand the risks and may legally hold these tokens.',
      'lokhus.com is not offered in the United States, Cuba, Iran, North Korea or Syria. Visits from those countries are blocked by IP address, and every account confirms its holder is not a US person and not in one of them.',
      'Every trade is decoded and checked like any other SODAX swap, and the output always returns to your Safe.',
    ],
    gap: 'SODAX’s copies can’t be redeemed for Robinhood’s tokens yet, so the only way out is to sell. Neither Lokhus nor SODAX checks your identity: the country check uses your IP address, which a VPN can hide.',
    you: 'Read Robinhood’s documentation, check that you may hold these tokens where you live (they may not be offered to US persons), and size positions for the chance of losing them.',
  },
  {
    title: 'The site goes down',
    risk: 'A traffic flood or an outage makes Lokhus unavailable.',
    measures: [
      'Our host filters network floods.',
      'Requests are rate limited per IP at the proxy, and per IP and per account in the app, tighter on sign-in and sign-up.',
    ],
    you: 'Your funds don’t depend on Lokhus. Your Safe works with any Safe interface, including Safe’s own app.',
  },
  {
    title: 'Public RPCs give wrong data',
    risk: 'The blockchain nodes the app reads from report wrong balances or state.',
    measures: [
      'Hashes and signatures never depend on RPC data, so a lying node can mislead what you see but not what you sign.',
      'You can point each chain at your own RPC in Settings.',
    ],
  },
]

export const Trust = () => {
  return (
    <PublicShell>

      <main>
        <section className="landing-hero">
          <h1 className="landing-title">How Lokhus can fail, and what we do about it.</h1>
          <p className="landing-lede">
            Lokhus never holds your keys and never moves funds on its own. Every transaction is signed by your own wallets and
            executed by the Safe contracts onchain. These are the ways the app could still get between you and what you sign.
          </p>
        </section>

        <section className="landing-facts" aria-label="Risks">
          {RISKS.map(({ title, risk, measures, gap, you }) => (
            <div key={title} className="landing-fact">
              <h2>{title}</h2>
              <div className="trust-detail">
                <p>{risk}</p>
                <h3>What we do</h3>
                <ul>
                  {measures.map((measure) => (
                    <li key={measure}>{measure}</li>
                  ))}
                </ul>
                {gap && (
                  <>
                    <h3>Not done yet</h3>
                    <p>{gap}</p>
                  </>
                )}
                {you && (
                  <>
                    <h3>What you can do</h3>
                    <p>{you}</p>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="landing-fact">
            <h2>Found a problem?</h2>
            <div className="trust-detail">
              <p>
                Email <a href="mailto:security@lokhus.com">security@lokhus.com</a>. Please don’t post it publicly until it’s fixed.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        The contracts your funds touch (Safe, SODAX) are checked live on the <Link to="/security">Security page</Link>. Lokhus is an
        independent project, not made or endorsed by Safe, SODAX or Robinhood; it uses their public contracts and APIs. Country
        lookups use{' '}
        <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
          IP Geolocation by DB-IP
        </a>{' '}
        (CC BY 4.0), looked up on our own server without any third-party service.
        <SourceLink />
      </footer>
    </PublicShell>
  )
}
