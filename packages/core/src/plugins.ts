import type { PublicClient } from 'viem'
import type { ActionDetail, Address, ChainConfig, DeployedSafe, FollowUp, Hex, MetaTx, TxAction } from './types.ts'

export interface EIP1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

export interface WalletConnection {
  pluginId: string
  address: Address
  provider: EIP1193Provider
  via?: string
  switchChain(chain: ChainConfig): Promise<void>
  disconnect(): Promise<void>
  forget?(): Promise<void>
}

export interface AccountChoice {
  address: Address
  label: string
}

export interface AccountPickOptions {
  title?: string
  newLabel?: string
}

export interface WalletUi {
  showQr(uri: string): void
  hideQr(): void
  pickAccount(choices: AccountChoice[], options?: AccountPickOptions): Promise<number>
}

export interface WalletPlugin {
  id: string
  label: string
  description: string
  icon?: string
  isAvailable(): boolean
  connect(ctx: { chain: ChainConfig; ui: WalletUi }): Promise<WalletConnection>
}

export type ActionFieldType = 'address' | 'addresses' | 'amount' | 'token' | 'text' | 'textarea' | 'select'

export interface ActionField {
  name: string
  label: string
  type: ActionFieldType
  placeholder?: string
  help?: string
  optional?: boolean
  options?: { value: string; label: string }[]
}

export interface ActionContext {
  chain: ChainConfig
  safe: DeployedSafe
  client: PublicClient
}

export interface BuiltAction {
  calls: MetaTx[]
  summary: string
  checks?: string[]
  details?: ActionDetail[]
  expiresAt?: number
  meta?: Record<string, unknown>
}

export interface ActionPlugin {
  id: string
  label: string
  description: string
  supports(chain: ChainConfig): boolean
  fields(ctx: ActionContext): ActionField[]
  build(input: Record<string, string>, ctx: ActionContext): Promise<BuiltAction>
  preview?(input: Record<string, string>, ctx: ActionContext): Promise<ActionDetail[] | null>
  afterExecute?(action: TxAction, executedTxHash: Hex, ctx: ActionContext): Promise<Omit<FollowUp, 'at'>>
  status?(action: TxAction, executedTxHash: Hex, ctx: ActionContext): Promise<Omit<FollowUp, 'at'>>
}

export class Registry<T extends { id: string }> {
  private items = new Map<string, T>()

  register(item: T): this {
    this.items.set(item.id, item)
    return this
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  list(): T[] {
    return [...this.items.values()]
  }
}
