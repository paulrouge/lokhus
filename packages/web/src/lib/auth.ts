import { useEffect, useSyncExternalStore } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { ELIGIBILITY, type Acknowledgment, type AcknowledgmentFields, type AcknowledgmentKind, type EligibilityConfirmation } from '@msa/core'
import { PRF_INPUT, toB64u } from '../crypto/keys.ts'

export interface AuthStatus {
  mode: 'self' | 'hosted'
  needsSetupCode: boolean
  accountExists: boolean
  registrationOpen: boolean
  awaitingPasskey: boolean
  signedIn: boolean
  account: { id: string; name: string } | null
  regionBlocked: boolean
  needsEligibility: boolean
}

export interface PasskeyInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export interface LockedKey {
  kind: 'prf' | 'passphrase' | 'recovery'
  wrapped: string
  salt: string | null
}

export interface KeyStatus {
  check: string | null
  migrated: boolean
  keys: { passkeyId: string; kind: LockedKey['kind'] }[]
  hasRecoveryCode: boolean
  wallets: { addresses: string[]; threshold: number } | null
}

export interface PasskeyUse {
  passkeyId: string
  prf: Uint8Array<ArrayBuffer> | null
}

class AuthError extends Error {
  readonly code: string | null
  readonly status: number

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.status = status
    this.code = code
  }
}

const rawCall = async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const response = await fetch(`/api/auth/${path}`, {
    method,
    headers: { 'X-MSA': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 204) return null as T
  const data = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null
  if (!response.ok && path !== 'status' && (data?.code === 'region' || data?.code === 'eligibility')) void refreshAuth()
  if (!response.ok) throw new AuthError(data?.error ?? `Request failed (${response.status})`, response.status, data?.code ?? null)
  return data as T
}

const call = async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  try {
    return await rawCall<T>(path, method, body)
  } catch (error) {
    if (!(error instanceof AuthError) || error.code !== 'step_up') throw error
    await confirmWithPasskey()
    return rawCall<T>(path, method, body)
  }
}

let status: AuthStatus | null = null
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()

const publish = (next: AuthStatus) => {
  status = next
  listeners.forEach((listener) => listener())
}

export const refreshAuth = () => {
  pending ??= rawCall<AuthStatus>('status')
    .then(publish)
    .finally(() => {
      pending = null
    })
  return pending
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const currentAuth = () => status

const PRERENDER_STATUS: AuthStatus = {
  mode: 'hosted',
  needsSetupCode: false,
  accountExists: false,
  registrationOpen: true,
  awaitingPasskey: false,
  signedIn: false,
  account: null,
  regionBlocked: false,
  needsEligibility: false,
}

export const useAuth = () => {
  const current = useSyncExternalStore(subscribe, () => status, () => PRERENDER_STATUS)
  useEffect(() => {
    if (!status) void refreshAuth()
  }, [])
  return current
}

const passkeyError = (error: unknown) => {
  if (error instanceof Error && error.name === 'NotAllowedError') return new Error('The passkey prompt was closed before it finished.')
  return error instanceof Error ? error : new Error(String(error))
}

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON']
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']
type ExtensionResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } } }

const withPrf = <T extends { extensions?: object }>(options: T): T =>
  ({ ...options, extensions: { ...options.extensions, prf: { eval: { first: PRF_INPUT } } } }) as T

const takePrf = <T extends { clientExtensionResults: unknown }>(response: T) => {
  const first = (response.clientExtensionResults as ExtensionResults).prf?.results?.first
  const prf = first ? new Uint8Array(first instanceof Uint8Array ? first : new Uint8Array(first)) as Uint8Array<ArrayBuffer> : null
  return { response: { ...response, clientExtensionResults: {} }, prf }
}

const register = async (options: RegistrationOptions) => {
  const raw = await startRegistration({ optionsJSON: withPrf(options) }).catch((error: unknown) => {
    throw isPreviouslyRegistered(error) ? error : passkeyError(error)
  })
  return takePrf(raw)
}

const authenticate = async (options: AuthenticationOptions) => {
  const raw = await startAuthentication({ optionsJSON: withPrf(options) }).catch((error: unknown) => {
    throw passkeyError(error)
  })
  return takePrf(raw)
}

export const promptPasskey = async (passkeyId?: string): Promise<PasskeyUse> => {
  const { response, prf } = await authenticate({
    challenge: toB64u(crypto.getRandomValues(new Uint8Array(32))),
    rpId: window.location.hostname,
    userVerification: 'preferred',
    allowCredentials: passkeyId ? [{ id: passkeyId, type: 'public-key' }] : [],
  })
  return { passkeyId: response.id, prf }
}

const afterRegistration = async (passkeyId: string, prf: Uint8Array<ArrayBuffer> | null): Promise<PasskeyUse> =>
  prf ? { passkeyId, prf } : promptPasskey(passkeyId).catch(() => ({ passkeyId, prf: null }))

let lastPasskey: PasskeyUse | null = null

export const takeLastPasskey = () => {
  const used = lastPasskey
  lastPasskey = null
  return used
}

export const createAccount = async (accountName: string, setupCode: string, eligibility?: number) => {
  const options = await rawCall<RegistrationOptions>('register/options', 'POST', { accountName, setupCode, eligibility })
  const { response, prf } = await register(options)
  const result = await rawCall<{ passkeyId: string }>('register/verify', 'POST', { response, setupCode, eligibility })
  lastPasskey = await afterRegistration(result.passkeyId, prf)
  await refreshAuth()
}

export const signIn = async () => {
  const options = await rawCall<AuthenticationOptions>('login/options', 'POST', {})
  const { response, prf } = await authenticate(options)
  const result = await rawCall<{ passkeyId: string }>('login/verify', 'POST', { response })
  lastPasskey = { passkeyId: result.passkeyId, prf }
  await refreshAuth()
}

export const confirmWithPasskey = async (): Promise<PasskeyUse> => {
  const options = await rawCall<AuthenticationOptions>('stepup/options', 'POST', {})
  const { response, prf } = await authenticate(options)
  const result = await rawCall<{ passkeyId: string }>('stepup/verify', 'POST', { response })
  return { passkeyId: result.passkeyId, prf }
}

export const confirmEligibility = async () => {
  await rawCall('eligibility', 'POST', { version: ELIGIBILITY.version })
  await refreshAuth()
}

export const signOut = async () => {
  await rawCall('logout', 'POST', {})
  await refreshAuth()
}

export const signOutEverywhere = async () => {
  await rawCall('logout-all', 'POST', {})
  await refreshAuth()
}

export const renameAccount = async (name: string) => {
  await rawCall('account', 'PUT', { name })
  await refreshAuth()
}

export const listPasskeys = () => rawCall<PasskeyInfo[]>('passkeys')

export const addPasskey = async (): Promise<PasskeyUse> => {
  const options = await call<RegistrationOptions>('passkeys/options', 'POST', {})
  const { response, prf } = await register(options)
  const result = await rawCall<{ passkeyId: string }>('passkeys/verify', 'POST', { response })
  return afterRegistration(result.passkeyId, prf)
}

export const renamePasskey = (id: string, name: string) => rawCall(`passkeys/${encodeURIComponent(id)}`, 'PUT', { name })

export const removePasskey = (id: string) => call(`passkeys/${encodeURIComponent(id)}`, 'DELETE')

export const keyStatus = () => rawCall<KeyStatus>('keys')

export const setKeyCheck = (check: string) => rawCall<{ check: string }>('keys/check', 'PUT', { check })

export const markMigrated = () => rawCall('keys/migrated', 'POST', {})

export const lockedKeyFor = (passkeyId: string) =>
  rawCall<LockedKey>(`keys/passkey/${encodeURIComponent(passkeyId)}`).catch((error: unknown) => {
    if (error instanceof AuthError && error.status === 404) return null
    throw error
  })

export const saveLockedKey = (passkeyId: string, key: Omit<LockedKey, 'kind'> & { kind: 'prf' | 'passphrase' }) =>
  call(`keys/passkey/${encodeURIComponent(passkeyId)}`, 'PUT', key)

export const saveRecoveryCode = (authSecret: string, wrapped: string) => call('recovery/code', 'PUT', { authSecret, wrapped, salt: null })

export const saveRecoveryWallets = (addresses: string[] | null, threshold: number) =>
  call('recovery/wallets', 'PUT', addresses ? { addresses, threshold } : { addresses: null })

export const resetEncryptedData = async () => {
  await call('keys/reset', 'POST', {})
}

export const findRecoveryCode = (authSecret: string) =>
  rawCall<{ grant: string; account: { name: string }; locked: LockedKey }>('recover/code', 'POST', { authSecret })

export const walletRecoveryChallenge = () => rawCall<{ challenge: string; message: string }>('recover/wallets/options', 'POST', {})

export const recoverWithWallets = (challenge: string, signatures: string[]) =>
  rawCall<{ grant: string; account: { name: string } }>('recover/wallets/verify', 'POST', { challenge, signatures })

export const isPreviouslyRegistered = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  ((error as { code?: unknown }).code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || (error as { name?: unknown }).name === 'InvalidStateError')

const confirmExistingRecoveryPasskey = async (grant: string): Promise<PasskeyUse> => {
  const options = await rawCall<AuthenticationOptions>('recover/passkey/assert/options', 'POST', { grant })
  const { response, prf } = await authenticate(options)
  const result = await rawCall<{ passkeyId: string }>('recover/passkey/assert/verify', 'POST', { grant, response })
  return { passkeyId: result.passkeyId, prf }
}

export const registerRecoveryPasskey = async (grant: string, onExistingPasskey: () => void = () => {}) => {
  const options = await rawCall<RegistrationOptions>('recover/passkey/options', 'POST', { grant })
  try {
    const { response, prf } = await register(options)
    const result = await rawCall<{ passkeyId: string }>('recover/passkey/verify', 'POST', { grant, response })
    lastPasskey = await afterRegistration(result.passkeyId, prf)
  } catch (error) {
    if (!isPreviouslyRegistered(error)) throw error
    onExistingPasskey()
    lastPasskey = await confirmExistingRecoveryPasskey(grant)
  }
  await refreshAuth()
  return lastPasskey
}

export interface Backup {
  format: 'lokhus-backup-1'
  exportedAt: string
  account: { id: string; name: string }
  vault: { check: string | null; keys: ({ passkeyId: string } & LockedKey)[]; recovery: LockedKey | null }
  acknowledgments: Acknowledgment[]
  eligibility: EligibilityConfirmation[]
  docs: { collection: string; id: string; data: unknown }[]
}

export const acknowledgmentFor = (kind: AcknowledgmentKind) =>
  rawCall<{ kind: AcknowledgmentKind; version: number; required: boolean; acknowledgment: Acknowledgment | null }>(`acknowledgments/${kind}`)

export const saveAcknowledgment = (fields: AcknowledgmentFields & { message: string; signature: string }) =>
  rawCall<Acknowledgment>('acknowledgments', 'POST', fields)

export const downloadBackup = () => call<Backup>('export')

export const deleteAccount = async (confirmName: string) => {
  await call('account', 'DELETE', { confirmName })
  await refreshAuth()
}
