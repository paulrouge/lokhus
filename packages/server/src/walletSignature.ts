import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

export const personalMessageHash = (message: string) => {
  const body = Buffer.from(message, 'utf8')
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]))
}

export const recoverPersonalSigner = (message: string, signature: string): string | null => {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null
  const bytes = Buffer.from(signature.slice(2), 'hex')
  const v = bytes[64]!
  const recovery = v >= 27 ? v - 27 : v
  if (recovery !== 0 && recovery !== 1) return null
  try {
    const point = secp256k1.Signature.fromCompact(bytes.subarray(0, 64)).addRecoveryBit(recovery).recoverPublicKey(personalMessageHash(message))
    const uncompressed = point.toRawBytes(false)
    return `0x${hex(keccak_256(uncompressed.subarray(1)).subarray(12))}`
  } catch {
    return null
  }
}
