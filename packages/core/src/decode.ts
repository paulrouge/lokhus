import {
  decodeAbiParameters,
  decodeFunctionData,
  size,
  slice,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from 'viem'
import { erc20Abi, multiSendAbi, safeAbi } from './safe/abi.ts'
import { sodaxAssetManagerAbi, sodaxIntentsAbi } from './actions/sodax.ts'
import type { Hex } from './types.ts'

export interface DecodedValue {
  name: string
  type: string
  value?: string
  children?: DecodedValue[]
  call?: DecodedCall
}

export interface DecodedCall {
  functionName: string
  signature: string
  args: DecodedValue[]
}

const KNOWN_ABIS: Abi[] = [safeAbi, erc20Abi, multiSendAbi, sodaxAssetManagerAbi, sodaxIntentsAbi]
const CALL_BATCH = [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }] as const
const MAX_DEPTH = 4

const decodeMultiSend = (packed: Hex, depth: number): DecodedValue[] => {
  const calls: DecodedValue[] = []
  let offset = 0
  const total = size(packed)
  while (offset < total) {
    const operation = Number(BigInt(slice(packed, offset, offset + 1)))
    const to = slice(packed, offset + 1, offset + 21)
    const value = BigInt(slice(packed, offset + 21, offset + 53))
    const dataLength = Number(BigInt(slice(packed, offset + 53, offset + 85)))
    const data = dataLength ? slice(packed, offset + 85, offset + 85 + dataLength) : '0x'
    calls.push({
      name: `call ${calls.length + 1}`,
      type: 'call',
      children: [
        { name: 'operation', type: 'uint8', value: operation === 1 ? '1 (delegatecall)' : '0 (call)' },
        { name: 'to', type: 'address', value: to },
        { name: 'value', type: 'uint256', value: value.toString() },
        bytesValue('data', data, depth + 1),
      ],
    })
    offset += 85 + dataLength
  }
  return calls
}

const bytesValue = (name: string, data: Hex, depth: number): DecodedValue => {
  const base = { name, type: 'bytes', value: data }
  if (depth >= MAX_DEPTH || data === '0x') return base
  const call = decodeCalldata(data, [], depth + 1)
  if (call) return { ...base, call }
  try {
    const [batch] = decodeAbiParameters(CALL_BATCH, data)
    return {
      ...base,
      children: batch.map(([to, value, inner], index) => ({
        name: `call ${index + 1}`,
        type: 'call',
        children: [
          { name: 'to', type: 'address', value: to },
          { name: 'value', type: 'uint256', value: value.toString() },
          bytesValue('data', inner, depth + 1),
        ],
      })),
    }
  } catch {
    return base
  }
}

const toValue = (param: AbiParameter, value: unknown, index: number, depth: number): DecodedValue => {
  const name = param.name || `arg${index}`
  if (param.type === 'bytes') return bytesValue(name, value as Hex, depth)
  if (param.type === 'tuple' && 'components' in param) {
    const record = value as Record<string, unknown> & unknown[]
    return {
      name,
      type: 'tuple',
      children: param.components.map((component, i) => toValue(component, record[component.name ?? ''] ?? record[i], i, depth)),
    }
  }
  if (Array.isArray(value)) {
    const itemType = param.type.replace(/\[\d*\]$/, '')
    const item = { ...param, type: itemType } as AbiParameter
    return { name, type: param.type, children: value.map((entry, i) => toValue({ ...item, name: `[${i}]` }, entry, i, depth)) }
  }
  return { name, type: param.type, value: String(value) }
}

export const decodeCalldata = (data: Hex, extraAbis: Abi[] = [], depth = 0): DecodedCall | null => {
  if (size(data) < 4) return null
  for (const abi of [...extraAbis, ...KNOWN_ABIS]) {
    try {
      const { functionName, args = [] } = decodeFunctionData({ abi, data })
      const fn = abi.find(
        (item): item is AbiFunction =>
          item.type === 'function' && item.name === functionName && item.inputs.length === args.length,
      )
      if (!fn) continue
      const decodedArgs =
        abi === multiSendAbi
          ? [{ name: 'transactions', type: 'bytes', value: args[0] as Hex, children: decodeMultiSend(args[0] as Hex, depth) }]
          : fn.inputs.map((input, index) => toValue(input, args[index], index, depth))
      return { functionName, signature: toFunctionSignature(fn), args: decodedArgs }
    } catch {}
  }
  return null
}
