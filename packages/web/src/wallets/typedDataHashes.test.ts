import { describe, expect, it } from 'vitest'
import { concat, getAddress, getTypesForEIP712Domain, keccak256, parseEther, serializeTypedData } from 'viem'
import { buildSafeTx, safeTxHash, safeTxTypedData } from '@msa/core'
import { typedDataHashes } from './typedDataHashes.ts'

const SAFE = getAddress('0x1111111111111111111111111111111111111111')
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222')

describe('typedDataHashes', () => {
  it('rebuilds the Safe tx hash from the JSON a wallet receives', () => {
    const tx = buildSafeTx(
      [
        { to: RECIPIENT, value: parseEther('2').toString(), data: '0x' },
        { to: RECIPIENT, value: '1', data: '0xdeadbeef' },
      ],
      12n,
      146,
    )
    const typedData = safeTxTypedData(tx, SAFE, 146)
    const request = {
      ...typedData,
      types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types },
    } as Parameters<typeof serializeTypedData>[0]
    const json = serializeTypedData(request)
    const { domainHash, messageHash } = typedDataHashes(json)
    expect(keccak256(concat(['0x1901', domainHash, messageHash]))).toBe(safeTxHash(tx, SAFE, 146))
  })
})
