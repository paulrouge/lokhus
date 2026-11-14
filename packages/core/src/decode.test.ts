import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, zeroAddress } from 'viem'
import { decodeCalldata } from './decode.ts'
import { erc20Abi } from './safe/abi.ts'
import { encodeMultiSend } from './safe/tx.ts'
import { sodaxAssetManagerAbi } from './actions/sodax.ts'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

describe('decodeCalldata', () => {
  it('decodes an ERC20 transfer', () => {
    const decoded = decodeCalldata(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [A, 5n] }))
    expect(decoded?.signature).toBe('transfer(address,uint256)')
    expect(decoded?.args.map((arg) => arg.value)).toEqual([A, '5'])
  })

  it('decodes nested calls inside a SODAX deposit payload', () => {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [B, 7n] })
    const payload = encodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
      [[[A, 0n, approve]]],
    )
    const decoded = decodeCalldata(
      encodeFunctionData({ abi: sodaxAssetManagerAbi, functionName: 'transfer', args: [zeroAddress, B, 7n, payload] }),
    )
    const data = decoded!.args.find((arg) => arg.name === 'data')!
    expect(data.children?.[0]?.children?.[2]?.call?.functionName).toBe('approve')
  })

  it('splits a MultiSend batch into its calls', () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [A, 1n] })
    const decoded = decodeCalldata(
      encodeMultiSend([
        { to: A, value: '0', data: transfer },
        { to: B, value: '3', data: '0x' },
      ]),
    )
    const calls = decoded!.args[0]!.children!
    expect(calls).toHaveLength(2)
    expect(calls[0]!.children![3]!.call?.functionName).toBe('transfer')
  })

  it('returns null for unknown selectors', () => {
    expect(decodeCalldata('0xdeadbeef00')).toBeNull()
  })
})
