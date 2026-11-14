import { useEffect } from 'react'

export const SITE_URL = 'https://lokhus.com'

export interface PageMeta {
  title: string
  description: string
}

export const PUBLIC_META: Record<string, PageMeta> = {
  '/welcome': {
    title: 'Lokhus: a self-custody console for your Safe multisig',
    description:
      'Keep long-term crypto in a Safe that several of your own keys protect. See what every transaction does before you sign, swap and earn through SODAX, and sign with Ledger, phone or browser wallets one at a time.',
  },
  '/trust': {
    title: 'Trust: how Lokhus can fail, and what handles it | Lokhus',
    description:
      'Every risk of the hosted Lokhus app, from a domain takeover to a compromised server, and the measures that handle each one: passkeys, end-to-end encryption, onchain checks.',
  },
  '/security': {
    title: 'Security: the contracts behind Lokhus | Lokhus',
    description: 'Live onchain checks of the Safe and SODAX contracts your funds touch on Polygon, Sonic, Base and Ethereum.',
  },
  '/best-practice': {
    title: 'Best practice: keys, backups and recovery for a Safe | Lokhus',
    description:
      'How to pick signers for a personal Safe multisig, back them up and recover when a key is lost: hardware wallets, cards, phones and threshold choices.',
  },
}

export const DEFAULT_META: PageMeta = {
  title: 'Lokhus',
  description: 'A self-custody console for your Safe multisig: several of your own keys, transactions you can read before you sign.',
}

export const usePageMeta = (path?: string) => {
  useEffect(() => {
    const meta = (path && PUBLIC_META[path]) || DEFAULT_META
    document.title = meta.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description)
  }, [path])
}
