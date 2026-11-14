import type { SafeTxRecord } from '@msa/core'

export const missingNonces = (record: SafeTxRecord, onchainNonce: bigint | null, records: SafeTxRecord[]): bigint[] => {
  if (onchainNonce === null || record.status !== 'pending') return []
  const target = BigInt(record.tx.nonce)
  const queued = new Set(records.filter((entry) => entry.status === 'pending').map((entry) => entry.tx.nonce))
  const missing: bigint[] = []
  for (let nonce = onchainNonce; nonce < target; nonce++) if (!queued.has(nonce.toString())) missing.push(nonce)
  return missing
}

export const describeNonces = (nonces: bigint[]) =>
  nonces.length === 1 ? `#${nonces[0]}` : `#${nonces[0]} to #${nonces[nonces.length - 1]}`
