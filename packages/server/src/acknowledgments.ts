import type { DatabaseSync } from 'node:sqlite'
import { ACKNOWLEDGMENTS, acknowledgmentMessage, isAcknowledgmentKind, type Acknowledgment, type AcknowledgmentKind } from '@msa/core/acknowledgment'
import { HttpError } from './http.ts'
import { recoverPersonalSigner } from './walletSignature.ts'

export const ACKNOWLEDGMENT_CLOCK_SKEW_MS = 60 * 60 * 1000

export interface AcknowledgmentStore {
  get(accountId: string, kind: AcknowledgmentKind, version: number): Promise<Acknowledgment | null>
  add(accountId: string, acknowledgment: Omit<Acknowledgment, 'createdAt'>): Promise<Acknowledgment>
  list(accountId: string): Promise<Acknowledgment[]>
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export const verifyAcknowledgment = (body: Record<string, unknown>, now: number): Omit<Acknowledgment, 'createdAt'> => {
  const { kind, signer, safe, chainId, blockNumber, date, message, signature } = body
  if (!isAcknowledgmentKind(kind)) throw new HttpError(400, 'Unknown acknowledgment')
  if (typeof signer !== 'string' || !ADDRESS.test(signer)) throw new HttpError(400, 'Invalid signer address')
  if (typeof safe !== 'string' || !ADDRESS.test(safe)) throw new HttpError(400, 'Invalid Safe address')
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) throw new HttpError(400, 'Invalid chain id')
  if (typeof blockNumber !== 'string' || !/^[0-9]{1,20}$/.test(blockNumber)) throw new HttpError(400, 'Invalid block number')
  const at = typeof date === 'string' ? Date.parse(date) : NaN
  if (typeof date !== 'string' || Number.isNaN(at) || new Date(at).toISOString() !== date) throw new HttpError(400, 'Invalid date')
  if (Math.abs(at - now) > ACKNOWLEDGMENT_CLOCK_SKEW_MS) throw new HttpError(400, 'The date in the message is too far from now')
  const fields = { kind, signer, safe, chainId, blockNumber, date }
  if (message !== acknowledgmentMessage(fields)) throw new HttpError(400, 'The message does not match the current acknowledgment text')
  if (typeof signature !== 'string') throw new HttpError(400, 'Invalid signature')
  const recovered = recoverPersonalSigner(message, signature)
  if (!recovered || recovered !== signer.toLowerCase()) throw new HttpError(400, 'The signature is not from the signer in the message')
  return { ...fields, signer: recovered, version: ACKNOWLEDGMENTS[kind].version, message, signature: signature.toLowerCase() }
}

type Row = Record<string, string | number | null>

export const toAcknowledgment = (row: Record<string, unknown>): Acknowledgment => ({
  kind: row.kind as AcknowledgmentKind,
  version: Number(row.version),
  message: row.message as string,
  signature: row.signature as string,
  signer: row.signer as string,
  safe: row.safe as string,
  chainId: Number(row.chain_id),
  blockNumber: row.block_number as string,
  date: row.signed_date as string,
  createdAt: row.created_at as string,
})

export const createAcknowledgmentStore = (db: DatabaseSync, now: () => number = Date.now): AcknowledgmentStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS acknowledgments (
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      message TEXT NOT NULL,
      signature TEXT NOT NULL,
      signer TEXT NOT NULL,
      safe TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      block_number TEXT NOT NULL,
      signed_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, kind, version)
    );
  `)

  const get = (accountId: string, kind: AcknowledgmentKind, version: number) => {
    const row = db.prepare('SELECT * FROM acknowledgments WHERE account_id = ? AND kind = ? AND version = ?').get(accountId, kind, version) as Row | undefined
    return row ? toAcknowledgment(row) : null
  }

  return {
    get: async (accountId, kind, version) => get(accountId, kind, version),
    add: async (accountId, ack) => {
      db.prepare(
        `INSERT INTO acknowledgments (account_id, kind, version, message, signature, signer, safe, chain_id, block_number, signed_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(accountId, ack.kind, ack.version, ack.message, ack.signature, ack.signer, ack.safe, ack.chainId, ack.blockNumber, ack.date, new Date(now()).toISOString())
      return get(accountId, ack.kind, ack.version)!
    },
    list: async (accountId) =>
      (db.prepare('SELECT * FROM acknowledgments WHERE account_id = ? ORDER BY created_at, kind, version').all(accountId) as Row[]).map(toAcknowledgment),
  }
}
