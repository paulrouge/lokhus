import { useEffect, useState, type ReactNode } from 'react'
import {
  AUDITS,
  DEFAULT_CHAINS,
  TRUSTED_CONTRACTS,
  explorerLink,
  inspectContract,
  readSafeHealth,
  type ChainConfig,
  type ContractInspection,
  type SafeHealth,
  type TrustedContract,
} from '@msa/core'
import { clientFor, useChains, useCollection } from '../state/data.tsx'
import { Badge, Card, ChainPill } from '../components/ui.tsx'
import { errorMessage, shortAddress } from '../lib/format.ts'

type Result = { inspection?: ContractInspection; error?: string }

const useInspections = (byId: Map<number, ChainConfig>) => {
  const [results, setResults] = useState<Record<string, Result>>({})
  const ready = TRUSTED_CONTRACTS.every((contract) => byId.has(contract.chainId))
  useEffect(() => {
    let cancelled = false
    for (const contract of TRUSTED_CONTRACTS) {
      const chain = byId.get(contract.chainId)
      if (!chain) continue
      inspectContract(clientFor(chain), contract)
        .then((inspection) => !cancelled && setResults((current) => ({ ...current, [contract.id]: { inspection } })))
        .catch((cause) => !cancelled && setResults((current) => ({ ...current, [contract.id]: { error: errorMessage(cause) } })))
    }
    return () => {
      cancelled = true
    }
  }, [ready])
  return results
}

type SafeCheck = { name: string; health?: SafeHealth; error?: string }

const useSafeHealth = (byId: Map<number, ChainConfig>) => {
  const { items: safes } = useCollection('safes')
  const [checks, setChecks] = useState<Record<string, SafeCheck>>({})
  const deployed = safes.filter((safe) => safe.status === 'deployed' && safe.address && byId.has(safe.chainId))
  const key = deployed.map((safe) => safe.id).join(',')
  useEffect(() => {
    let cancelled = false
    setChecks({})
    for (const safe of deployed) {
      const done = (check: Omit<SafeCheck, 'name'>) =>
        !cancelled && setChecks((current) => ({ ...current, [safe.id]: { name: safe.name, ...check } }))
      readSafeHealth(clientFor(byId.get(safe.chainId)!), safe.address!, safe.chainId)
        .then((health) => done({ health }))
        .catch((cause) => done({ error: errorMessage(cause) }))
    }
    return () => {
      cancelled = true
    }
  }, [key])
  return { checks: Object.values(checks), expected: deployed.length }
}

const controlBadge = (inspection?: ContractInspection) => {
  if (!inspection) return <Badge>Checking…</Badge>
  switch (inspection.controllerKind) {
    case 'immutable':
      return <Badge tone="good">Immutable</Badge>
    case 'missing':
      return <Badge tone="bad">No code at this address</Badge>
    case 'timelock':
      return <Badge tone="good">Timelock {Math.round((inspection.timelockDelaySeconds ?? 0) / 3600)}h</Badge>
    case 'safe':
      return (
        <Badge>
          Upgradeable by {inspection.controllerThreshold}/{inspection.controllerOwners} Safe
        </Badge>
      )
    case 'eoa':
      return <Badge tone="bad">Upgradeable by one key</Badge>
    default:
      return <Badge tone="warn">Upgradeable, unknown controller</Badge>
  }
}

const pinBadge = (contract: TrustedContract, inspection?: ContractInspection) => {
  if (!inspection) return null
  if (inspection.changedSincePin) return <Badge tone="bad">Code changed since {contract.pinnedAt}</Badge>
  if (!contract.pinnedImplementation) return null
  return <Badge>Same code as {contract.pinnedAt}</Badge>
}

const ContractRow = ({ contract, chain, result }: { contract: TrustedContract; chain?: ChainConfig; result?: Result }) => {
  const inspection = result?.inspection
  return (
    <div className={`security-row ${inspection?.changedSincePin ? 'is-bad' : ''}`}>
      <div className="security-row-head">
        <strong>{contract.name}</strong>
        {chain && <ChainPill chain={chain} />}
      </div>
      <span className="muted small">{contract.role}</span>
      <div className="row gap-sm wrap">
        {controlBadge(inspection)}
        {pinBadge(contract, inspection)}
      </div>
      <div className="security-links small">
        {chain && (
          <a className="link" href={explorerLink(chain, 'address', contract.address)} target="_blank" rel="noreferrer">
            {shortAddress(contract.address)} ↗
          </a>
        )}
        {chain && inspection?.implementation && (
          <a
            className="link"
            href={`${explorerLink(chain, 'address', inspection.implementation)}#code`}
            target="_blank"
            rel="noreferrer"
          >
            Source of implementation {shortAddress(inspection.implementation)} ↗
          </a>
        )}
        {chain && !inspection?.implementation && inspection && (
          <a className="link" href={`${explorerLink(chain, 'address', contract.address)}#code`} target="_blank" rel="noreferrer">
            Source ↗
          </a>
        )}
      </div>
      {result?.error && <span className="muted tiny">Could not read: {result.error}</span>}
    </div>
  )
}

type Verdict = 'safe' | 'note' | 'risk' | 'pending'

const Story = ({
  question,
  verdict,
  answer,
  children,
}: {
  question: string
  verdict: Verdict
  answer: string
  children: ReactNode
}) => (
  <section className={`story is-${verdict}`}>
    <h3>{question}</h3>
    <p>
      <strong className="story-answer">{answer}.</strong> {children}
    </p>
  </section>
)

type SafeChecks = { checks: SafeCheck[]; expected: number }

const safeAnswer = (verdict: Verdict, issues: string[], safeChecks?: SafeChecks) => {
  if (verdict === 'pending') return safeChecks ? 'Reading the code, modules, guard and fallback handler of each of your Safes…' : 'Reading the Safe contracts…'
  if (verdict === 'safe') {
    if (!safeChecks)
      return 'A Safe created with Lokhus runs the official Safe code with no modules or guard, so only its own signers can move funds. The Safe code is fixed forever: nobody, not even the Safe team, can change how a Safe works.'
    const subject =
      safeChecks.expected === 1 ? 'Your Safe runs' : safeChecks.expected ? `All ${safeChecks.expected} of your Safes run` : 'Safes created here run'
    return `${subject} the official Safe code with no modules or guard, so only your own signers can move funds. The Safe code is fixed forever: nobody, not even the Safe team, can change how your Safe works.`
  }
  if (issues.length) return `${issues.join('. ')}. Unless you added this yourself, move funds to a fresh Safe.`
  return 'An official Safe contract does not look immutable from here. Check the Safe contracts list below.'
}

const Findings = ({ results, safeChecks }: { results: Record<string, Result>; safeChecks?: SafeChecks }) => {
  const sodax = TRUSTED_CONTRACTS.filter((contract) => contract.group === 'sodax')
  const safes = TRUSTED_CONTRACTS.filter((contract) => contract.group === 'safe')
  const inspected = sodax
    .map((contract) => results[contract.id]?.inspection)
    .filter((entry): entry is ContractInspection => !!entry)
  const loading = inspected.length < sodax.length
  const changed = sodax.filter((contract) => results[contract.id]?.inspection?.changedSincePin)
  const controllers = [...new Set(inspected.map((entry) => entry.controller?.toLowerCase()).filter(Boolean))]
  const controller = inspected.find((entry) => entry.controller)
  const singleKey = inspected.some((entry) => entry.controllerKind === 'eoa')
  const timelocked = inspected.length > 0 && inspected.every((entry) => entry.controllerKind === 'timelock')
  const safeImmutable = safes.every((contract) => results[contract.id]?.inspection?.controllerKind === 'immutable')
  const safesLoading =
    !safes.every((contract) => results[contract.id]?.inspection) || (!!safeChecks && safeChecks.checks.length < safeChecks.expected)
  const safeIssues = (safeChecks?.checks ?? []).flatMap((check) =>
    check.error ? [`${check.name}: could not be checked (${check.error})`] : (check.health?.problems ?? []).map((problem) => `${check.name} ${problem}`),
  )
  const safeVerdict: Verdict = safesLoading ? 'pending' : safeIssues.length || !safeImmutable ? 'risk' : 'safe'
  const keys =
    controller?.controllerKind === 'safe'
      ? `${controller.controllerThreshold} of ${controller.controllerOwners} SODAX team keys`
      : 'the SODAX team'

  return (
    <div className="stories">
      <Story
        question={safeChecks ? 'Is the money sitting in my Safe safe?' : 'Is money sitting in a Safe safe?'}
        verdict={safeVerdict}
        answer={safeVerdict === 'pending' ? 'Checking' : safeVerdict === 'safe' ? 'Yes' : 'Check this'}
      >
        {safeAnswer(safeVerdict, safeIssues, safeChecks)}
      </Story>

      <Story
        question="What changes when I swap or supply on SODAX?"
        verdict={loading ? 'pending' : singleKey ? 'risk' : 'note'}
        answer={loading ? 'Checking' : singleKey ? 'Real risk' : 'You trust SODAX'}
      >
        {loading
          ? 'Reading who controls the SODAX contracts…'
          : singleKey
            ? 'Those tokens leave your Safe and sit in SODAX contracts that a single key can rewrite. If that key leaks, the funds in them can be taken.'
            : timelocked
              ? 'Those tokens leave your Safe and sit in SODAX contracts. Any change to that code is announced days ahead, so you would have time to pull out first.'
              : `Those tokens leave your Safe and sit in SODAX contracts. ${keys} can update that code instantly${controllers.length > 1 ? '' : ', for every contract at once'}. That is how bugs get fixed fast, and it means your SODAX balance is as safe as those keys and the code itself. Keep there what you actively use; the rest stays in the Safe.`}
      </Story>

      <Story
        question="Has SODAX changed its code since we last checked?"
        verdict={loading ? 'pending' : changed.length ? 'risk' : 'safe'}
        answer={loading ? 'Checking' : changed.length ? 'Yes' : 'No'}
      >
        {loading
          ? 'Comparing the code running now with the pinned versions…'
          : changed.length
            ? `${changed.map((contract) => contract.name).join(', ')} now run${changed.length === 1 ? 's' : ''} different code than on ${changed[0]!.pinnedAt}. Read what changed before moving more funds there.`
            : `Every SODAX contract runs the exact same code as on ${sodax[0]?.pinnedAt}. This page tells you the moment that changes.`}
      </Story>

      <Story question="Can I check all of this myself?" verdict="safe" answer="Yes">
        Every contract below links to its published source on the chain's block explorer, and the audit reports are listed further
        down. Nothing here asks you to take our word for it.
      </Story>
    </div>
  )
}

const SecurityBody = ({ byId, safeChecks }: { byId: Map<number, ChainConfig>; safeChecks?: SafeChecks }) => {
  const results = useInspections(byId)
  const groups: { group: 'safe' | 'sodax'; title: string; subtitle: string }[] = [
    { group: 'sodax', title: 'SODAX contracts', subtitle: 'Touched by swaps, supplies and withdrawals.' },
    { group: 'safe', title: 'Safe contracts', subtitle: 'Safes on Polygon, Sonic, Base and Ethereum run on these.' },
  ]

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div>
          <p className="eyebrow">Security</p>
          <h1>{safeChecks ? 'Every contract your funds touch' : 'The contracts behind Lokhus'}</h1>
          <p className="muted">Read live from the chain: who can change the code, whether it changed, and where to read it.</p>
        </div>
      </div>

      <Card title="In plain words" subtitle="Worked out live from the chain every time you open this page.">
        <Findings results={results} safeChecks={safeChecks} />
      </Card>

      {groups.map(({ group, title, subtitle }) => (
        <Card key={group} title={title} subtitle={subtitle}>
          <div className="security-list">
            {TRUSTED_CONTRACTS.filter((contract) => contract.group === group).map((contract) => (
              <ContractRow
                key={contract.id}
                contract={contract}
                chain={byId.get(contract.chainId)}
                result={results[contract.id]}
              />
            ))}
          </div>
        </Card>
      ))}

      <Card
        title="Published audits"
        subtitle="Reports by external auditors. Read the open and acknowledged findings, not just the title."
      >
        <div className="stack gap-md">
          {groups.map(({ group, title }) => (
            <div key={group} className="stack gap-xs">
              <strong className="small">{title}</strong>
              {AUDITS[group].map((audit) => (
                <a key={audit.url} className="audit-row" href={audit.url} target="_blank" rel="noreferrer">
                  <span className="grow">
                    <strong>{audit.title}</strong>
                    <span className="muted tiny block">{audit.scope}</span>
                  </span>
                  {audit.date && <span className="muted small mono">{audit.date}</span>}
                  <span className="link small">Open ↗</span>
                </a>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Our review process" subtitle="How to audit these yourself before trusting them with real money.">
        <ol className="practice-steps">
          {[
            [
              'Read the code that runs',
              'Open each "Source of implementation" link. Focus on who can move tokens, what the owner can change, and every external call.',
            ],
            [
              'Check who can change it',
              'An upgrade key can replace the code at any time. A timelock gives you days to exit first; a plain multisig gives you none.',
            ],
            [
              'Read the audits',
              'Look for findings marked acknowledged or unresolved, and check the audited commit matches what is deployed.',
            ],
            [
              'Pin what you reviewed',
              'Record the implementation address and date in packages/core/src/security.ts (pinnedImplementation, pinnedAt).',
            ],
            [
              'Watch for upgrades',
              'This page flags any implementation that differs from the pin. Changed code means review again before moving funds.',
            ],
            [
              'Limit exposure',
              'Keep only what you actively use in swaps or the money market. Long-term holdings stay in the Safe itself.',
            ],
          ].map(([title, body], index) => (
            <li key={title} className="practice-step">
              <span className="practice-index">{index + 1}</span>
              <div className="stack gap-xs">
                <strong>{title}</strong>
                <div className="muted">{body}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}

export const Security = () => {
  const { byId } = useChains()
  const safeChecks = useSafeHealth(byId)
  return <SecurityBody byId={byId} safeChecks={safeChecks} />
}

const defaultChainsById = new Map(DEFAULT_CHAINS.map((chain) => [chain.chainId, chain]))

export const PublicSecurity = () => <SecurityBody byId={defaultChainsById} />
