import { DEFAULT_CHAINS } from './chains.ts'
import type { Storage } from './storage.ts'

export const seedDefaults = async (storage: Storage) => {
  const existing = await storage.list('chains')
  const known = new Set(existing.map((chain) => chain.id))
  await Promise.all(DEFAULT_CHAINS.filter((chain) => !known.has(chain.id)).map((chain) => storage.put('chains', chain)))
}
