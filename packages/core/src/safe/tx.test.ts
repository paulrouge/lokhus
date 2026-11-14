import { describe, expect, it } from 'vitest'
import { calculateSafeTransactionHash, encodeMultiSendData } from '@safe-global/protocol-kit'
import { OperationType } from '@safe-global/types-kit'
import { concat, decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { erc20Abi, multiSendAbi } from './abi.ts'
import {
  assertSafeTxRecord,
  assertStoredSignatures,
  buildSafeTx,
  encodeMultiSend,
  multiSendCallOnlyAddress,
  packSignatures,
  recoverSafeTxSigner,
  safeTxHash,
  safeTxHashParts,
  safeTxTypedData,
} from './tx.ts'
import type { MetaTx, SafeTxRecord, TxSignature } from '../types.ts'

const SAFE = getAddress('0x1111111111111111111111111111111111111111')
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN = getAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')

const calls: MetaTx[] = [
  { to: RECIPIENT, value: parseEther('1.5').toString(), data: '0x' },
  {
    to: TOKEN,
    value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, 1_000_000n] }),
  },
]

describe('buildSafeTx', () => {
  it('uses a plain call for a single action', () => {
    const tx = buildSafeTx([calls[0]!], 7n, 137)
    expect(tx).toMatchObject({ to: RECIPIENT, value: calls[0]!.value, data: '0x', operation: 0, nonce: '7' })
  })

  it('batches several calls through MultiSendCallOnly with a delegatecall', () => {
    const tx = buildSafeTx(calls, 0n, 137)
    expect(tx.operation).toBe(1)
    expect(tx.to).toBe(multiSendCallOnlyAddress(137))
    expect(tx.value).toBe('0')
  })

  it('knows MultiSendCallOnly on Polygon and Sonic', () => {
    expect(multiSendCallOnlyAddress(137)).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(multiSendCallOnlyAddress(146)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('encodeMultiSend', () => {
  it('matches the Safe SDK encoding', () => {
    const { args } = decodeFunctionData({ abi: multiSendAbi, data: encodeMultiSend(calls) })
    const expected = encodeMultiSendData(calls.map((call) => ({ ...call, operation: OperationType.Call })))
    expect(args[0]).toBe(expected)
  })
})

describe('safeTxHash', () => {
  it('matches the Safe SDK hash for single and batched transactions', () => {
    for (const tx of [buildSafeTx([calls[0]!], 3n, 137), buildSafeTx(calls, 4n, 146)]) {
      const chainId = tx.operation === 1 ? 146 : 137
      const sdkTx = { ...tx, nonce: Number(tx.nonce) }
      expect(safeTxHash(tx, SAFE, chainId)).toBe(calculateSafeTransactionHash(SAFE, sdkTx, '1.4.1', BigInt(chainId)))
    }
  })
})

describe('signatures', () => {
  const ownerA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const ownerB = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
  const tx = buildSafeTx(calls, 1n, 137)

  it('recovers the owner from an EIP-712 signature', async () => {
    const signature = await ownerA.signTypedData(safeTxTypedData(tx, SAFE, 137))
    expect(await recoverSafeTxSigner(tx, SAFE, 137, signature)).toBe(ownerA.address)
  })

  it('packs signatures sorted by signer address', async () => {
    const signed: TxSignature[] = await Promise.all(
      [ownerA, ownerB].map(async (owner) => ({
        signer: owner.address,
        data: await owner.signTypedData(safeTxTypedData(tx, SAFE, 137)),
        signedAt: '',
      })),
    )
    const [low, high] = [...signed].sort((a, b) => a.signer.toLowerCase().localeCompare(b.signer.toLowerCase()))
    expect(packSignatures(signed.reverse())).toBe(`${low!.data}${high!.data.slice(2)}`)
  })
})

describe('safeTxHashParts', () => {
  it('combines domain and message hashes into the Safe tx hash', () => {
    const tx = buildSafeTx(calls, 9n, 137)
    const parts = safeTxHashParts(tx, SAFE, 137)
    expect(keccak256(concat(['0x1901', parts.domainHash, parts.messageHash]))).toBe(parts.safeTxHash)
    expect(parts.safeTxHash).toBe(safeTxHash(tx, SAFE, 137))
  })
})

describe('stored transaction integrity', () => {
  const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const attacker = getAddress('0x4444444444444444444444444444444444444444')
  const record = (overrides: Partial<SafeTxRecord> = {}): SafeTxRecord => {
    const tx = buildSafeTx(calls, 3n, 137)
    return {
      id: safeTxHash(tx, SAFE, 137),
      safeId: 's',
      chainId: 137,
      safeAddress: SAFE,
      tx,
      action: { pluginId: 'transfer', input: {}, summary: 'Send', calls },
      signatures: [],
      status: 'pending',
      createdAt: '',
      ...overrides,
    }
  }
  const tamperedTx = (changes: Partial<SafeTxRecord['tx']>) => {
    const tx = { ...buildSafeTx(calls, 3n, 137), ...changes }
    return record({ tx, id: safeTxHash(tx, SAFE, 137) })
  }

  it('accepts a record built from its own calls', () => {
    expect(() => assertSafeTxRecord(record())).not.toThrow()
  })

  it.each([
    ['delegatecall to another contract', tamperedTx({ to: attacker }), /other than MultiSendCallOnly/],
    ['swapped calldata', tamperedTx({ data: '0xdeadbeef' }), /data does not match/],
    ['plain call to another target', tamperedTx({ operation: 0, to: attacker }), /does not match/],
    ['id that is not the hash', record({ id: `0x${'00'.repeat(32)}` }), /not its Safe tx hash/],
  ] as const)('refuses %s', (_, tampered, message) => {
    expect(() => assertSafeTxRecord(tampered)).toThrow(message)
  })

  it('refuses stored signatures that do not recover to their signer', async () => {
    const good = record()
    const signature = await owner.signTypedData(safeTxTypedData(good.tx, SAFE, 137))
    await expect(assertStoredSignatures({ ...good, signatures: [{ signer: owner.address, data: signature, signedAt: '' }] })).resolves.toBeUndefined()
    await expect(assertStoredSignatures({ ...good, signatures: [{ signer: attacker, data: signature, signedAt: '' }] })).rejects.toThrow(
      /was made by/,
    )
  })
})
