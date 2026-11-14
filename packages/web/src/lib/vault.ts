import { useSyncExternalStore } from 'react'
import {
  fromB64u,
  keyCheck,
  lockDataKey,
  lockKeyFromPassphrase,
  lockKeyFromSecret,
  newDataKey,
  newRecoveryCode,
  open,
  recoveryParts,
  seal,
  toB64u,
  unlockDataKey,
  workingKeys,
  type Bytes,
  type WorkingKeys,
} from '../crypto/keys.ts'
import { forgetAllDevices, forgetDevice, readDevice, writeDevice } from './deviceStore.ts'
import {
  findRecoveryCode,
  keyStatus,
  lockedKeyFor,
  saveLockedKey,
  saveRecoveryCode,
  setKeyCheck,
  type LockedKey,
  type PasskeyUse,
} from './auth.ts'

const DEVICE_AAD = 'lokhus device v1'
const REMEMBER = 'lokhus.remember'
const AUTOLOCK = 'lokhus.autolockMinutes'
const LAST_ACTIVE = 'lokhus.lastActive'
const MIGRATE_FOR = 'lokhus.migrateFor'

export const MIN_PASSPHRASE = 12

interface Unlocked {
  accountId: string
  keys: WorkingKeys
  deviceKey: CryptoKey
  sealed: string
}

let unlocked: Unlocked | null = null
let version = 0
const listeners = new Set<() => void>()

const changed = () => {
  version += 1
  listeners.forEach((listener) => listener())
}

export const vaultKeys = () => unlocked?.keys ?? null

export const isUnlockedFor = (accountId: string) => unlocked?.accountId === accountId

export const useVault = () => {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
  )
  return { unlocked: !!unlocked, accountId: unlocked?.accountId ?? null }
}

export const rememberOnDevice = () => localStorage.getItem(REMEMBER) !== '0'

export const autoLockMinutes = () => Number(localStorage.getItem(AUTOLOCK) ?? '0') || 0

const idleTooLong = () => {
  const minutes = autoLockMinutes()
  const last = Number(localStorage.getItem(LAST_ACTIVE) ?? '0')
  return minutes > 0 && last > 0 && Date.now() - last > minutes * 60_000
}

export const noteActivity = () => localStorage.setItem(LAST_ACTIVE, String(Date.now()))

export const plaintextImportDueFor = (accountId: string) => localStorage.getItem(MIGRATE_FOR) === accountId

export const plaintextImportDone = () => localStorage.removeItem(MIGRATE_FOR)

const adopt = async (accountId: string, dataKey: Bytes) => {
  const keys = await workingKeys(dataKey)
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const sealed = await seal(deviceKey, dataKey, DEVICE_AAD)
  dataKey.fill(0)
  unlocked = { accountId, keys, deviceKey, sealed }
  noteActivity()
  if (rememberOnDevice()) await writeDevice({ accountId, deviceKey, sealed, lockedAt: null }).catch(() => {})
  changed()
  return keys
}

const verified = async (accountId: string, dataKey: Bytes, check: string | null) => {
  if (check && (await keyCheck(await workingKeys(dataKey))) !== check) throw new Error('This key belongs to different data')
  return adopt(accountId, dataKey)
}

const withDataKey = async <T,>(use: (dataKey: Bytes) => Promise<T>) => {
  if (!unlocked) throw new Error('Unlock your data first')
  const dataKey = await open(unlocked.deviceKey, unlocked.sealed, DEVICE_AAD)
  try {
    return await use(dataKey)
  } finally {
    dataKey.fill(0)
  }
}

export const restoreFromDevice = async (accountId: string) => {
  if (isUnlockedFor(accountId)) return true
  if (idleTooLong()) return false
  const record = await readDevice(accountId).catch(() => undefined)
  if (!record || record.lockedAt) return false
  try {
    const dataKey = await open(record.deviceKey, record.sealed, DEVICE_AAD)
    unlocked = { accountId, keys: await workingKeys(dataKey), deviceKey: record.deviceKey, sealed: record.sealed }
    dataKey.fill(0)
    noteActivity()
    changed()
    return true
  } catch {
    await forgetDevice(accountId).catch(() => {})
    return false
  }
}

export const lockVault = async () => {
  const accountId = unlocked?.accountId
  unlocked = null
  changed()
  if (!accountId) return
  const record = await readDevice(accountId).catch(() => undefined)
  if (record) await writeDevice({ ...record, lockedAt: Date.now() }).catch(() => {})
}

export const forgetVault = async () => {
  unlocked = null
  changed()
  await forgetAllDevices().catch(() => {})
}

export const setRememberOnDevice = async (remember: boolean) => {
  localStorage.setItem(REMEMBER, remember ? '1' : '0')
  if (!unlocked) return
  if (remember) await writeDevice({ accountId: unlocked.accountId, deviceKey: unlocked.deviceKey, sealed: unlocked.sealed, lockedAt: null })
  else await forgetDevice(unlocked.accountId)
}

export const setAutoLockMinutes = (minutes: number) => {
  localStorage.setItem(AUTOLOCK, String(minutes))
  noteActivity()
}

export const checkIdle = () => {
  if (unlocked && idleTooLong()) void lockVault()
}

const passphraseLock = async (passphrase: string, salt?: string | null) => {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters`)
  const saltBytes = salt ? fromB64u(salt) : crypto.getRandomValues(new Uint8Array(16))
  return { lock: await lockKeyFromPassphrase(passphrase, saltBytes), salt: toB64u(saltBytes) }
}

export type UnlockOutcome =
  | { kind: 'unlocked' }
  | { kind: 'setup' }
  | { kind: 'passphrase'; passkeyId: string; salt: string }
  | { kind: 'no-key'; passkeyId: string; prf: Bytes | null }

export const unlockWithPasskey = async (accountId: string, used: PasskeyUse): Promise<UnlockOutcome> => {
  const status = await keyStatus()
  if (!status.check) return { kind: 'setup' }
  const locked = await lockedKeyFor(used.passkeyId)
  if (locked?.kind === 'passphrase' && locked.salt) return { kind: 'passphrase', passkeyId: used.passkeyId, salt: locked.salt }
  if (locked?.kind === 'prf' && used.prf) {
    await verified(accountId, await unlockDataKey(await lockKeyFromSecret(used.prf), locked.wrapped), status.check)
    return { kind: 'unlocked' }
  }
  return { kind: 'no-key', passkeyId: used.passkeyId, prf: used.prf }
}

export const unlockWithPassphrase = async (accountId: string, passkeyId: string, passphrase: string) => {
  const [status, locked] = await Promise.all([keyStatus(), lockedKeyFor(passkeyId)])
  if (!locked || locked.kind !== 'passphrase') throw new Error('This passkey has no passphrase')
  const { lock } = await passphraseLock(passphrase, locked.salt)
  await verified(accountId, await unlockDataKey(lock, locked.wrapped).catch(() => {
    throw new Error('That passphrase does not unlock your data')
  }), status.check)
}

export const protectPasskey = async (used: PasskeyUse, passphrase?: string) =>
  withDataKey(async (dataKey) => {
    if (used.prf) {
      await saveLockedKey(used.passkeyId, { kind: 'prf', wrapped: await lockDataKey(await lockKeyFromSecret(used.prf), dataKey), salt: null })
      return
    }
    if (!passphrase) throw new Error('This passkey cannot unlock data by itself. Choose a passphrase for it.')
    const { lock, salt } = await passphraseLock(passphrase)
    await saveLockedKey(used.passkeyId, { kind: 'passphrase', wrapped: await lockDataKey(lock, dataKey), salt })
  })

export const createVault = async (accountId: string, used: PasskeyUse, passphrase?: string) => {
  if (!used.prf && (!passphrase || passphrase.length < MIN_PASSPHRASE)) throw new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters`)
  const dataKey = newDataKey()
  const keys = await workingKeys(dataKey)
  const check = await keyCheck(keys)
  if ((await setKeyCheck(check)).check !== check) throw new Error('Your account already has an encryption key. Reload and sign in again.')
  localStorage.setItem(MIGRATE_FOR, accountId)
  const code = newRecoveryCode()
  const parts = await recoveryParts(code)
  await saveRecoveryCode(parts.authSecret, await lockDataKey(parts.lock, dataKey))
  await adopt(accountId, dataKey)
  await protectPasskey(used, passphrase)
  return code
}

export const regenerateRecoveryCode = async () => {
  const code = newRecoveryCode()
  const parts = await recoveryParts(code)
  await withDataKey(async (dataKey) => saveRecoveryCode(parts.authSecret, await lockDataKey(parts.lock, dataKey)))
  return code
}

export const unlockWithRecoveryCode = async (accountId: string, code: string, locked?: LockedKey) => {
  const parts = await recoveryParts(code)
  const lockedKey = locked ?? (await findRecoveryCode(parts.authSecret)).locked
  const status = await keyStatus()
  const dataKey = await unlockDataKey(parts.lock, lockedKey.wrapped).catch(() => {
    throw new Error('That recovery code does not unlock your data')
  })
  await verified(accountId, dataKey, status.check)
}
