import type { ActivityItem, ChainConfig, ContractEntry, Note, Owner, SafeRecord, SafeTxRecord } from './types.ts'

export interface CollectionMap {
  chains: ChainConfig
  owners: Owner
  safes: SafeRecord
  txs: SafeTxRecord
  notes: Note
  contracts: ContractEntry
  activity: ActivityItem
}

export type CollectionName = keyof CollectionMap

export const COLLECTIONS: CollectionName[] = ['chains', 'owners', 'safes', 'txs', 'notes', 'contracts', 'activity']

export type Filter = Record<string, string | number | boolean>

export const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/

export const PAGE_LIMIT_MAX = 200

export interface PageOrder {
  field: string
  numeric?: boolean
}

export interface PageQuery {
  filter?: Filter
  order: PageOrder[]
  direction: 'asc' | 'desc'
  limit: number
  cursor?: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface Storage {
  list<C extends CollectionName>(collection: C, filter?: Filter): Promise<CollectionMap[C][]>
  page<C extends CollectionName>(collection: C, query: PageQuery): Promise<Page<CollectionMap[C]>>
  get<C extends CollectionName>(collection: C, id: string): Promise<CollectionMap[C] | null>
  put<C extends CollectionName>(collection: C, item: CollectionMap[C]): Promise<CollectionMap[C]>
  remove(collection: CollectionName, id: string): Promise<void>
}
