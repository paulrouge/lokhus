import { describe, expect, it } from 'vitest'
import { keccak256, pad, toHex, type PublicClient } from 'viem'
import { assertRealSafe, readSafeHealth, verifyMultiSendCallOnly } from './onchain.ts'
import { multiSendCallOnlyAddress, SAFE_MULTISEND_CALL_ONLY } from './tx.ts'
import type { Address, Hex } from '../types.ts'

const SAFE: Address = '0x1111111111111111111111111111111111111111'
const SINGLETON_L2_141: Address = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
const SINGLETON_130: Address = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552'
const HANDLER_141: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'
const ATTACKER: Address = '0x3333333333333333333333333333333333333333'

interface Onchain {
  singleton?: Address
  guard?: Address
  handler?: Address
  version?: string
  modules?: readonly Address[]
}

const word = (address?: Address) => pad(address ?? '0x0', { size: 32 })

const fakeClient = (state: Onchain = {}) => {
  const slots: Record<string, string> = {
    [pad('0x0', { size: 32 })]: word(state.singleton ?? SINGLETON_L2_141),
    [keccak256(toHex('guard_manager.guard.address'))]: word(state.guard),
    [keccak256(toHex('fallback_manager.handler.address'))]: word(state.handler ?? HANDLER_141),
  }
  return {
    getStorageAt: async ({ slot }: { slot: string }) => slots[slot],
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'VERSION') return state.version ?? '1.4.1'
      if (functionName === 'getModulesPaginated') return [state.modules ?? [], '0x0000000000000000000000000000000000000001']
      throw new Error(`unexpected ${functionName}`)
    },
  } as unknown as PublicClient
}

describe('safe health', () => {
  it('passes an official Safe with no modules or guard', async () => {
    const health = await readSafeHealth(fakeClient(), SAFE, 137)
    expect(health.problems).toEqual([])
    expect(health.singleton).toBe(SINGLETON_L2_141)
  })

  it('accepts an official 1.3.0 Safe', async () => {
    await expect(assertRealSafe(fakeClient({ singleton: SINGLETON_130, version: '1.3.0' }), SAFE, 146)).resolves.toBeTruthy()
  })

  it.each([
    ['a module', { modules: [ATTACKER] }, /module 0x3333.*enabled/],
    ['a guard', { guard: ATTACKER }, /guard 0x3333/],
    ['a foreign fallback handler', { handler: ATTACKER }, /fallback handler 0x3333/],
    ['a foreign singleton', { singleton: ATTACKER }, /non-standard Safe code/],
    ['an old version', { version: '1.1.1' }, /version 1.1.1/],
  ] as const)('flags %s', async (_, state, message) => {
    const health = await readSafeHealth(fakeClient(state), SAFE, 137)
    expect(health.problems.join(' ')).toMatch(message)
  })

  it.each([
    ['fake proxy', { singleton: ATTACKER }],
    ['unsupported version', { version: '1.2.0' }],
  ] as const)('refuses to import a %s', async (_, state) => {
    await expect(assertRealSafe(fakeClient(state), SAFE, 137)).rejects.toThrow(/Not a standard Safe/)
  })

  it('imports a Safe with a module but reports it', async () => {
    const health = await assertRealSafe(fakeClient({ modules: [ATTACKER] }), SAFE, 137)
    expect(health.problems).toHaveLength(1)
  })
})

describe('pinned MultiSendCallOnly', () => {
  const clientWithCode = (code: Hex | undefined) => ({ getCode: async () => code }) as unknown as PublicClient

  it('is the address Safe deployments list on Polygon and Sonic', () => {
    expect(multiSendCallOnlyAddress(137)).toBe(SAFE_MULTISEND_CALL_ONLY.address)
    expect(multiSendCallOnlyAddress(146)).toBe(SAFE_MULTISEND_CALL_ONLY.address)
  })

  it('verifies the deployed code by hash', async () => {
    expect(await verifyMultiSendCallOnly(clientWithCode('0x6080'))).toBe(false)
    expect(await verifyMultiSendCallOnly(clientWithCode(undefined))).toBe(false)
  })
})
