import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeErrorResult, encodeFunctionResult, getAddress, keccak256, maxUint256, pad, parseAbi, toHex, type PublicClient } from 'viem'
import { DEFAULT_CHAINS } from '../chains.ts'
import type { Hex, SafeTxRecord } from '../types.ts'
import { safeAbi } from './abi.ts'
import { approvedHashSignatures, approvedHashSlot, effectsFromLogs, NATIVE_TRANSFER_LOG_ADDRESS, setupChanges, simulateSafeTx } from './simulate.ts'
import { buildSafeTx, safeTxHash } from './tx.ts'

const SAFE = getAddress('0x1111111111111111111111111111111111111111')
const OWNER_A = getAddress('0x00000000000000000000000000000000000000aa')
const OWNER_B = getAddress('0x00000000000000000000000000000000000000bb')
const OWNER_C = getAddress('0x00000000000000000000000000000000000000cc')
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222')
const SPENDER = getAddress('0x3333333333333333333333333333333333333333')
const UNKNOWN = getAddress('0x4444444444444444444444444444444444444444')
const MODULE = getAddress('0x5555555555555555555555555555555555555555')
const SINGLETON = getAddress('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762')
const polygon = DEFAULT_CHAINS.find((chain) => chain.chainId === 137)!
const USDC = getAddress(polygon.tokens.find((token) => token.symbol === 'USDC')!.address)

const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'))
const APPROVAL = keccak256(toHex('Approval(address,address,uint256)'))
const topic = (address: string) => pad(address as Hex, { size: 32 })
const amount = (value: bigint) => pad(toHex(value), { size: 32 })
const transfer = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: amount(value),
})

const setupAbi = parseAbi([
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
])

const setupReads = (owners: `0x${string}`[], threshold: bigint, modules: `0x${string}`[] = []) => [
  { status: '0x1', returnData: encodeFunctionResult({ abi: safeAbi, functionName: 'getOwners', result: owners }) },
  { status: '0x1', returnData: encodeFunctionResult({ abi: safeAbi, functionName: 'getThreshold', result: threshold }) },
  {
    status: '0x1',
    returnData: encodeFunctionResult({
      abi: setupAbi,
      functionName: 'getModulesPaginated',
      result: [modules, '0x0000000000000000000000000000000000000001'],
    }),
  },
  ...[pad(SINGLETON, { size: 32 }), pad('0x0', { size: 32 }), pad('0x0', { size: 32 })].map((word) => ({
    status: '0x1',
    returnData: encodeFunctionResult({ abi: setupAbi, functionName: 'getStorageAt', result: word }),
  })),
]

const record = (nonce = 4n): SafeTxRecord => {
  const tx = buildSafeTx([{ to: RECIPIENT, value: '1000', data: '0x' }], nonce, 137)
  return {
    id: safeTxHash(tx, SAFE, 137),
    safeId: 's',
    chainId: 137,
    safeAddress: SAFE,
    tx,
    action: { pluginId: 'transfer', input: {}, summary: 'Send', calls: [{ to: RECIPIENT, value: '1000', data: '0x' }] },
    signatures: [],
    status: 'pending',
    createdAt: '',
  }
}

const fakeClient = (simulate: (params: unknown) => unknown, call?: () => unknown) => {
  const request = vi.fn(async ({ params }: { params: unknown }) => simulate(params))
  const client = {
    readContract: async ({ functionName }: { functionName: string }) =>
      ({ getOwners: [OWNER_C, OWNER_A, OWNER_B], getThreshold: 2n, nonce: 4n, VERSION: '1.4.1', symbol: ' sUSDC ', decimals: 6 })[functionName],
    request,
    call: vi.fn(async () => call!()),
  } as unknown as PublicClient
  return { client, request }
}

describe('approved hash overrides', () => {
  it('computes the approvedHashes storage slot for owner and hash', () => {
    const hash = keccak256('0x1234')
    const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [OWNER_A, 8n]))
    expect(approvedHashSlot(OWNER_A, hash)).toBe(keccak256(`${hash}${inner.slice(2)}` as Hex))
  })

  it('packs v=1 signatures sorted by owner', () => {
    const packed = approvedHashSignatures([OWNER_B, OWNER_A])
    expect(packed).toBe(`${pad(OWNER_A, { size: 32 })}${'00'.repeat(32)}01${pad(OWNER_B, { size: 32 }).slice(2)}${'00'.repeat(32)}01`)
  })
})

describe('effectsFromLogs', () => {
  it('nets transfers per account with the Safe first and flags unlimited approvals', () => {
    const { deltas, approvals } = effectsFromLogs(
      [
        transfer(NATIVE_TRANSFER_LOG_ADDRESS, SAFE, RECIPIENT, 5n),
        transfer(USDC, SAFE, RECIPIENT, 1_000_000n),
        transfer(USDC, RECIPIENT, SAFE, 250_000n),
        transfer(UNKNOWN, RECIPIENT, SAFE, 7n),
        { address: USDC, topics: [APPROVAL, topic(SAFE), topic(SPENDER)], data: amount(maxUint256) },
        { address: USDC, topics: [APPROVAL, topic(RECIPIENT), topic(SPENDER)], data: amount(1n) },
      ],
      SAFE,
      polygon,
    )
    expect(deltas[0]).toMatchObject({ address: SAFE, isSafe: true })
    expect(deltas[0]!.changes).toEqual([
      { token: 'native', symbol: 'POL', decimals: 18, listed: true, amount: -5n },
      { token: USDC, symbol: 'USDC', decimals: 6, listed: true, amount: -750_000n },
      { token: UNKNOWN, symbol: null, decimals: null, listed: false, amount: 7n },
    ])
    expect(deltas[1]).toMatchObject({ address: RECIPIENT, isSafe: false })
    expect(approvals).toEqual([{ token: USDC, symbol: 'USDC', decimals: 6, listed: true, spender: SPENDER, amount: maxUint256, unlimited: true }])
  })

  it('ignores NFT transfers and empty logs', () => {
    const nft = { address: UNKNOWN, topics: [TRANSFER, topic(SAFE), topic(RECIPIENT), amount(1n)], data: '0x' as Hex }
    expect(effectsFromLogs([nft], SAFE, polygon).deltas).toEqual([])
  })
})

describe('setupChanges', () => {
  const base = { owners: [OWNER_A, OWNER_B], threshold: 2n, modules: [], singleton: SINGLETON, guard: null, fallbackHandler: null }

  it('reports nothing when the setup is unchanged', () => {
    expect(setupChanges(base, { ...base })).toEqual([])
  })

  it('reports owner, threshold, module, code, guard and handler changes', () => {
    const changes = setupChanges(base, {
      owners: [OWNER_A, OWNER_C],
      threshold: 1n,
      modules: [MODULE],
      singleton: UNKNOWN,
      guard: SPENDER,
      fallbackHandler: RECIPIENT,
    })
    expect(changes).toEqual([
      `Adds owner ${OWNER_C}`,
      `Removes owner ${OWNER_B}`,
      'Changes the threshold from 2 to 1',
      `Enables module ${MODULE}, which can move funds without signatures`,
      `Replaces the Safe code ${SINGLETON} with ${UNKNOWN}`,
      `Sets the transaction guard to ${SPENDER}`,
      `Changes the fallback handler to ${RECIPIENT}`,
    ])
  })
})

describe('simulateSafeTx', () => {
  const succeeded = { status: '0x1', returnData: encodeFunctionResult({ abi: safeAbi, functionName: 'execTransaction', result: true }) }

  it('approves the hash for the lowest threshold owners and reads the effects', async () => {
    const { client, request } = fakeClient(() => [
      {
        calls: [
          ...setupReads([OWNER_A, OWNER_B, OWNER_C], 2n),
          { ...succeeded, logs: [transfer(NATIVE_TRANSFER_LOG_ADDRESS, SAFE, RECIPIENT, 1000n)] },
          ...setupReads([OWNER_A, OWNER_B, OWNER_C], 2n),
        ],
      },
    ])
    const tx = record()
    const result = await simulateSafeTx(client, tx, polygon)
    expect(result).toMatchObject({ mode: 'full', success: true, nonceOverridden: false, setupChanges: [] })
    expect(result.deltas[0]!.changes).toEqual([{ token: 'native', symbol: 'POL', decimals: 18, listed: true, amount: -1000n }])
    const [{ blockStateCalls, validation, traceTransfers }] = request.mock.calls[0]![0].params as [
      { blockStateCalls: [{ stateOverrides: Record<string, { stateDiff: Record<string, Hex> }>; calls: { from: string }[] }]; validation: boolean; traceTransfers: boolean },
    ]
    expect({ validation, traceTransfers }).toEqual({ validation: false, traceTransfers: true })
    expect(Object.keys(blockStateCalls[0].stateOverrides[SAFE]!.stateDiff).sort()).toEqual(
      [approvedHashSlot(OWNER_A, tx.id), approvedHashSlot(OWNER_B, tx.id)].sort(),
    )
    expect(blockStateCalls[0].calls[6]!.from).toBe(OWNER_A)
  })

  it('reads symbol and decimals onchain for unlisted tokens and keeps them marked unlisted', async () => {
    const { client } = fakeClient(() => [
      {
        calls: [
          ...setupReads([OWNER_A], 1n),
          { ...succeeded, logs: [transfer(UNKNOWN, RECIPIENT, SAFE, 7_000_000n)] },
          ...setupReads([OWNER_A], 1n),
        ],
      },
    ])
    const result = await simulateSafeTx(client, record(), polygon)
    expect(result.deltas[0]!.changes).toEqual([{ token: UNKNOWN, symbol: 'sUSDC', decimals: 6, listed: false, amount: 7_000_000n }])
  })

  it('overrides the nonce for a transaction queued behind others', async () => {
    const { client, request } = fakeClient(() => [{ calls: [...setupReads([OWNER_A], 1n), succeeded, ...setupReads([OWNER_A], 1n)] }])
    const result = await simulateSafeTx(client, record(6n), polygon)
    expect(result.nonceOverridden).toBe(true)
    const params = request.mock.calls[0]![0].params as [{ blockStateCalls: [{ stateOverrides: Record<string, { stateDiff: Record<string, Hex> }> }] }]
    expect(params[0].blockStateCalls[0].stateOverrides[SAFE]!.stateDiff[pad('0x5', { size: 32 })]).toBe(pad('0x6', { size: 32 }))
  })

  it('reports a setup change made by the transaction', async () => {
    const { client } = fakeClient(() => [
      { calls: [...setupReads([OWNER_A, OWNER_B], 2n), succeeded, ...setupReads([OWNER_A, OWNER_B], 2n, [MODULE])] },
    ])
    expect((await simulateSafeTx(client, record(), polygon)).setupChanges).toEqual([
      `Enables module ${MODULE}, which can move funds without signatures`,
    ])
  })

  it('reports the revert reason', async () => {
    const reverted = { status: '0x0', returnData: encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['GS013'] }) }
    const { client } = fakeClient(() => [{ calls: [...setupReads([OWNER_A], 1n), reverted, ...setupReads([OWNER_A], 1n)] }])
    expect(await simulateSafeTx(client, record(), polygon)).toMatchObject({ success: false, revertReason: 'GS013', deltas: [] })
  })

  it('falls back to a plain call when the RPC lacks eth_simulateV1', async () => {
    const unsupported = () => {
      throw new Error('the method eth_simulateV1 does not exist/is not available')
    }
    const ok = fakeClient(unsupported, () => ({ data: encodeFunctionResult({ abi: safeAbi, functionName: 'execTransaction', result: true }) }))
    expect(await simulateSafeTx(ok.client, record(), polygon)).toMatchObject({ mode: 'outcome-only', success: true })
    const failing = fakeClient(unsupported, () => {
      throw Object.assign(new Error('execution reverted'), {
        data: encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['GS013'] }),
      })
    })
    expect(await simulateSafeTx(failing.client, record(), polygon)).toMatchObject({ mode: 'outcome-only', success: false, revertReason: 'GS013' })
  })

  it('surfaces other RPC errors', async () => {
    const { client } = fakeClient(() => {
      throw new Error('rate limited')
    })
    await expect(simulateSafeTx(client, record(), polygon)).rejects.toThrow(/rate limited/)
  })
})
