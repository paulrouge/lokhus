import { describe, expect, it } from 'vitest'
import { isPreviouslyRegistered } from './auth.ts'

describe('recovery on a device that already has the passkey', () => {
  it('recognises the previously-registered error from SimpleWebAuthn and the raw browser error', () => {
    expect(isPreviouslyRegistered(Object.assign(new Error('The authenticator was previously registered'), { code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }))).toBe(true)
    expect(isPreviouslyRegistered(Object.assign(new Error('x'), { name: 'InvalidStateError' }))).toBe(true)
    expect(isPreviouslyRegistered(Object.assign(new Error('closed'), { name: 'NotAllowedError' }))).toBe(false)
    expect(isPreviouslyRegistered(null)).toBe(false)
  })
})
