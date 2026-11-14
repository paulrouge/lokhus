import {
  concat,
  encodeFunctionData,
  encodePacked,
  getAddress,
  domainSeparator,
  hashStruct,
  hashTypedData,
  recoverTypedDataAddress,
  size,
  zeroAddress,
} from 'viem'
import { getMultiSendCallOnlyDeployment } from '@safe-global/safe-deployments'
import type { Address, Hex, MetaTx, SafeTxData, SafeTxRecord, TxSignature } from '../types.ts'
import { multiSendAbi, safeAbi } from './abi.ts'

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export const SAFE_MULTISEND_CALL_ONLY = {
  name: 'Safe MultiSendCallOnly',
  version: '1.4.1',
  address: getAddress('0x9641d764fc13c8B624c04430C7356C1C7C8102e2'),
  codeHash: '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939' as Hex,
}

export const multiSendCallOnlyAddress = (chainId: number): Address => {
  const deployment = getMultiSendCallOnlyDeployment({ version: SAFE_MULTISEND_CALL_ONLY.version, network: String(chainId) })
  const listed = deployment?.networkAddresses[String(chainId)]
  if (!listed) throw new Error(`MultiSendCallOnly ${SAFE_MULTISEND_CALL_ONLY.version} is not deployed on chain ${chainId}`)
  const addresses: string[] = Array.isArray(listed) ? listed : [listed]
  if (!addresses.some((address) => address.toLowerCase() === SAFE_MULTISEND_CALL_ONLY.address.toLowerCase()))
    throw new Error(`MultiSendCallOnly on chain ${chainId} is not the pinned Safe contract`)
  return SAFE_MULTISEND_CALL_ONLY.address
}

export const encodeMultiSend = (calls: MetaTx[]): Hex => {
  const packed = calls.map((call) =>
    encodePacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [0, call.to, BigInt(call.value), BigInt(size(call.data)), call.data],
    ),
  )
  return encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [concat(packed)] })
}

export const buildSafeTx = (calls: MetaTx[], nonce: bigint, chainId: number): SafeTxData => {
  if (calls.length === 0) throw new Error('A Safe transaction needs at least one call')

  const base = {
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: nonce.toString(),
  }

  const [single] = calls
  if (calls.length === 1 && single) {
    return { ...base, to: single.to, value: single.value, data: single.data, operation: 0 }
  }

  return { ...base, to: multiSendCallOnlyAddress(chainId), value: '0', data: encodeMultiSend(calls), operation: 1 }
}

export const safeTxTypedData = (tx: SafeTxData, safeAddress: Address, chainId: number) => ({
  domain: { chainId, verifyingContract: safeAddress },
  types: SAFE_TX_TYPES,
  primaryType: 'SafeTx' as const,
  message: {
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: BigInt(tx.safeTxGas),
    baseGas: BigInt(tx.baseGas),
    gasPrice: BigInt(tx.gasPrice),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: BigInt(tx.nonce),
  },
})

export const safeTxHash = (tx: SafeTxData, safeAddress: Address, chainId: number): Hex =>
  hashTypedData(safeTxTypedData(tx, safeAddress, chainId))

export const safeTxHashParts = (tx: SafeTxData, safeAddress: Address, chainId: number) => {
  const typedData = safeTxTypedData(tx, safeAddress, chainId)
  return {
    domainHash: domainSeparator({ domain: typedData.domain }),
    messageHash: hashStruct({ data: typedData.message, primaryType: 'SafeTx', types: SAFE_TX_TYPES }),
    safeTxHash: hashTypedData(typedData),
  }
}

export const recoverSafeTxSigner = (tx: SafeTxData, safeAddress: Address, chainId: number, signature: Hex) =>
  recoverTypedDataAddress({ ...safeTxTypedData(tx, safeAddress, chainId), signature })

export const packSignatures = (signatures: TxSignature[]): Hex =>
  concat(
    [...signatures]
      .sort((a, b) => a.signer.toLowerCase().localeCompare(b.signer.toLowerCase()))
      .map((signature) => signature.data),
  )

export const execTransactionData = (tx: SafeTxData, signatures: TxSignature[]): Hex =>
  encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [
      tx.to,
      BigInt(tx.value),
      tx.data,
      tx.operation,
      BigInt(tx.safeTxGas),
      BigInt(tx.baseGas),
      BigInt(tx.gasPrice),
      tx.gasToken,
      tx.refundReceiver,
      packSignatures(signatures),
    ],
  })

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const safeTxRecordProblem = (record: SafeTxRecord): string | null => {
  const { tx, action, safeAddress, chainId } = record
  if (tx.operation !== 0 && tx.operation !== 1) return 'unknown operation'
  if (tx.operation === 1 && !same(tx.to, multiSendCallOnlyAddress(chainId))) return 'it delegatecalls a contract other than MultiSendCallOnly'
  let expected: SafeTxData
  try {
    expected = buildSafeTx(action.calls, BigInt(tx.nonce), chainId)
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  const field = (Object.keys(expected) as (keyof SafeTxData)[]).find((key) => !same(String(expected[key]), String(tx[key])))
  if (field) return `its ${field} does not match the reviewed calls`
  if (!same(safeTxHash(tx, safeAddress, chainId), record.id)) return 'its id is not its Safe tx hash'
  return null
}

export const assertSafeTxRecord = (record: SafeTxRecord) => {
  const problem = safeTxRecordProblem(record)
  if (problem) throw new Error(`Refusing this transaction: ${problem}`)
}

export const assertStoredSignatures = async (record: SafeTxRecord) => {
  for (const signature of record.signatures) {
    if (size(signature.data) !== 65) throw new Error(`Signature from ${signature.signer} is not 65 bytes`)
    const signer = await recoverSafeTxSigner(record.tx, record.safeAddress, record.chainId, signature.data)
    if (!same(signer, signature.signer)) throw new Error(`Stored signature for ${signature.signer} was made by ${signer}`)
  }
}
