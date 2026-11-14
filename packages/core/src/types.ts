export type Address = `0x${string}`
export type Hex = `0x${string}`

export interface Token {
  address: Address
  symbol: string
  decimals: number
}

export interface ChainConfig {
  id: string
  chainId: number
  name: string
  nativeSymbol: string
  rpcUrls: string[]
  explorerUrl: string
  tokens: Token[]
  safeVersion: '1.4.1'
}

export interface Owner {
  id: string
  address: Address
  label: string
  walletPluginId?: string
  lastConnectedAt?: string
  connectedVia?: string
  recoveryStoredAt?: string
  keyProof?: { at: string; message: string; signature: Hex }
}

export type SafeStatus = 'draft' | 'deployed'

export interface SafeRecord {
  id: string
  name: string
  chainId: number
  status: SafeStatus
  address?: Address
  owners: Address[]
  threshold: number
  saltNonce: string
  deploySetup?: { owners: Address[]; threshold: number; saltNonce: string }
  creation?: SafeCreation
  deployTxHash?: Hex
  deployBlock?: string
  scannedBlock?: string
  scannedAt?: string
  createdAt: string
}

export interface SafeCreation {
  factory: Address
  singleton: Address
  initializer: Hex
  saltNonce: string
  txHash?: Hex
}

export type DeployedSafe = SafeRecord & { status: 'deployed'; address: Address }

export interface MetaTx {
  to: Address
  value: string
  data: Hex
}

export interface SafeTxData {
  to: Address
  value: string
  data: Hex
  operation: 0 | 1
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: Address
  refundReceiver: Address
  nonce: string
}

export interface TxSignature {
  signer: Address
  data: Hex
  signedAt: string
}

export type TxStatus = 'pending' | 'executed' | 'replaced'

export interface ActionDetail {
  label: string
  value: string
  strong?: boolean
}

export type FollowUpState = 'progress' | 'needs-action' | 'done' | 'failed'

export interface FollowUp {
  label: string
  state: FollowUpState
  message?: string
  url?: string
  at: string
}

export interface TxAction {
  pluginId: string
  input: Record<string, string>
  summary: string
  calls: MetaTx[]
  checks?: string[]
  details?: ActionDetail[]
  expiresAt?: number
  meta?: Record<string, unknown>
}

export interface SafeTxRecord {
  id: Hex
  safeId: string
  chainId: number
  safeAddress: Address
  tx: SafeTxData
  action: TxAction
  signatures: TxSignature[]
  status: TxStatus
  executedTxHash?: Hex
  executedBy?: Address
  executedAt?: string
  followUp?: FollowUp
  createdAt: string
}

export type NoteEntity = 'general' | 'safe' | 'owner' | 'chain' | 'tx' | 'contract'

export interface Note {
  id: string
  entityType: NoteEntity
  entityId: string
  title?: string
  body: string
  pinned?: boolean
  updatedAt: string
}

export interface ContractEntry {
  id: string
  chainId: number
  address: Address
  name: string
  abi: unknown[]
}

export type ActivityKind =
  | 'executed'
  | 'failed'
  | 'received'
  | 'token-received'
  | 'owner-added'
  | 'owner-removed'
  | 'threshold-changed'

export interface ActivityItem {
  id: string
  safeId: string
  chainId: number
  kind: ActivityKind
  summary: string
  blockNumber: string
  timestamp: number
  txHash: Hex
  logIndex: number
  safeTxHash?: Hex
  nonce?: string
  counterparty?: Address
  token?: Address
  amountRaw?: string
  hidden?: 'unlisted-token' | 'zero-value'
}
