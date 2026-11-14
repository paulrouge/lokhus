import type { CollectionName } from '@msa/core'

export type Bytes = Uint8Array<ArrayBuffer>

const text = new TextEncoder()
const fromText = new TextDecoder()

export const toB64u = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const fromB64u = (value: string): Bytes => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const PRF_INPUT = text.encode('lokhus prf v1')

const HKDF_SALT = text.encode('lokhus v1')

export interface WorkingKeys {
  encrypt: CryptoKey
  ids: CryptoKey
}

const hkdfBase = (material: BufferSource) => crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey', 'deriveBits'])

const hkdfParams = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: text.encode(info) })

const aesKey = async (material: BufferSource, info: string) =>
  crypto.subtle.deriveKey(hkdfParams(info), await hkdfBase(material), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

const hmacKey = async (material: BufferSource, info: string) =>
  crypto.subtle.deriveKey(hkdfParams(info), await hkdfBase(material), { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])

export const newDataKey = (): Bytes => crypto.getRandomValues(new Uint8Array(32))

export const workingKeys = async (dataKey: Bytes): Promise<WorkingKeys> => ({
  encrypt: await aesKey(dataKey, 'lokhus data v1'),
  ids: await hmacKey(dataKey, 'lokhus ids v1'),
})

const mac = async (key: CryptoKey, value: string) => new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(value)))

export const keyCheck = async (keys: WorkingKeys) => toB64u(await mac(keys.ids, 'lokhus key check'))

export const seal = async (key: CryptoKey, plaintext: Bytes, aad: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(aad) }, key, plaintext))
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return toB64u(out)
}

export const open = async (key: CryptoKey, sealed: string, aad: string): Promise<Bytes> => {
  const bytes = fromB64u(sealed)
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: text.encode(aad) }, key, bytes.subarray(12)),
  )
}

const DATA_KEY_AAD = 'lokhus data key v1'

export const lockKeyFromSecret = (secret: BufferSource) => aesKey(secret, 'lokhus lock v1')

export const PASSPHRASE_ITERATIONS = 600_000

export const lockKeyFromPassphrase = async (passphrase: string, salt: Bytes, iterations = PASSPHRASE_ITERATIONS) => {
  const base = await crypto.subtle.importKey('raw', text.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

export const lockDataKey = (lock: CryptoKey, dataKey: Bytes) => seal(lock, dataKey, DATA_KEY_AAD)

export const unlockDataKey = async (lock: CryptoKey, wrapped: string): Promise<Bytes> => {
  try {
    return await open(lock, wrapped, DATA_KEY_AAD)
  } catch {
    throw new Error('This key does not unlock your data')
  }
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'
const RECOVERY_LENGTH = 25

export const newRecoveryCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH))
  const chars = Array.from(bytes, (byte) => RECOVERY_ALPHABET[byte & 31]!)
  return Array.from({ length: RECOVERY_LENGTH / 5 }, (_, group) => chars.slice(group * 5, group * 5 + 5).join('')).join('-')
}

export const normalizeRecoveryCode = (input: string) => {
  const cleaned = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (cleaned.length !== RECOVERY_LENGTH || [...cleaned].some((char) => !RECOVERY_ALPHABET.includes(char)))
    throw new Error('A recovery code has 25 letters and numbers, like ABCDE-FGHJK-MNPQR-STVWX-YZ012')
  return cleaned
}

export const recoveryParts = async (code: string) => {
  const material = text.encode(normalizeRecoveryCode(code))
  const authBits = new Uint8Array(await crypto.subtle.deriveBits(hkdfParams('lokhus recovery auth v1'), await hkdfBase(material), 256))
  return { authSecret: toHex(authBits), lock: await aesKey(material, 'lokhus recovery lock v1') }
}

export const INDEXED_FIELDS: Partial<Record<CollectionName, string[]>> = {
  txs: ['safeId', 'status'],
  notes: ['entityType', 'entityId'],
  activity: ['safeId'],
}

export const SORT_FIELDS: Partial<Record<CollectionName, string[]>> = {
  activity: ['blockNumber', 'logIndex'],
}

export interface EncryptedDoc {
  id: string
  v: 1
  enc: string
  [field: string]: unknown
}

export const isEncrypted = (doc: unknown): doc is EncryptedDoc =>
  !!doc && typeof doc === 'object' && (doc as { v?: unknown }).v === 1 && typeof (doc as { enc?: unknown }).enc === 'string'

export const hiddenId = async (keys: WorkingKeys, collection: CollectionName, id: string) => toB64u(await mac(keys.ids, `id\u0000${collection}\u0000${id}`))

export const hiddenValue = async (keys: WorkingKeys, collection: CollectionName, field: string, value: unknown) =>
  toB64u(await mac(keys.ids, `field\u0000${collection}\u0000${field}\u0000${String(value)}`))

export const encryptDoc = async (keys: WorkingKeys, collection: CollectionName, doc: { id: string }): Promise<EncryptedDoc> => {
  const id = await hiddenId(keys, collection, doc.id)
  const stored: EncryptedDoc = { id, v: 1, enc: await seal(keys.encrypt, text.encode(JSON.stringify(doc)), `${collection}/${id}`) }
  const record = doc as unknown as Record<string, unknown>
  for (const field of INDEXED_FIELDS[collection] ?? [])
    if (record[field] !== undefined && record[field] !== null) stored[field] = await hiddenValue(keys, collection, field, record[field])
  for (const field of SORT_FIELDS[collection] ?? []) if (record[field] !== undefined) stored[field] = record[field]
  return stored
}

export const decryptDoc = async <T extends { id: string }>(keys: WorkingKeys, collection: CollectionName, stored: EncryptedDoc): Promise<T> => {
  const doc = JSON.parse(fromText.decode(await open(keys.encrypt, stored.enc, `${collection}/${stored.id}`))) as T
  if ((await hiddenId(keys, collection, doc.id)) !== stored.id) throw new Error('A stored document does not match its id')
  return doc
}
