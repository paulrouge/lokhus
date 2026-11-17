export type AcknowledgmentKind = 'stocks'

export const ACKNOWLEDGMENTS: Record<AcknowledgmentKind, { version: number; title: string; points: string[] }> = {
  stocks: {
    version: 1,
    title: 'tokenized stocks',
    points: [
      'Lokhus is an independent project, not made or endorsed by SODAX or Robinhood. It never holds or controls my funds and takes no responsibility for any loss.',
      "Stock tokens traded through SODAX are copies of Robinhood's onchain stock tokens (debt securities issued by Robinhood Assets (Jersey) Limited). They give price exposure only, no shareholder rights, and can lose value or stop tracking the share.",
      'Neither Lokhus nor SODAX checks who I am. I alone am responsible for making sure I may legally use Lokhus and hold these tokens where I live. They may not be offered to US persons.',
    ],
  },
}

export const isAcknowledgmentKind = (value: unknown): value is AcknowledgmentKind =>
  typeof value === 'string' && Object.hasOwn(ACKNOWLEDGMENTS, value)

export interface AcknowledgmentFields {
  kind: AcknowledgmentKind
  signer: string
  safe: string
  chainId: number
  blockNumber: string
  date: string
}

export interface Acknowledgment extends AcknowledgmentFields {
  version: number
  message: string
  signature: string
  createdAt: string
}

export const acknowledgmentMessage = ({ kind, signer, safe, chainId, blockNumber, date }: AcknowledgmentFields) => {
  const { version, title, points } = ACKNOWLEDGMENTS[kind]
  return [
    `Lokhus acknowledgment: ${title} (version ${version})`,
    '',
    'I understand that:',
    ...points.map((point) => `- ${point}`),
    '',
    `Signer: ${signer}`,
    `Safe: ${safe} on chain ${chainId}`,
    `Block: ${blockNumber}`,
    `Date: ${date}`,
  ].join('\n')
}

export const ELIGIBILITY = {
  version: 1,
  statement:
    'I am not a US person: not a citizen or resident of the United States, and not a company or other entity organised there. I do not live in, and will not use Lokhus from, the United States, Cuba, Iran, North Korea or Syria. I am not named on a US, EU or UN sanctions list.',
}

export interface EligibilityConfirmation {
  version: number
  statement: string
  confirmedAt: string
}
