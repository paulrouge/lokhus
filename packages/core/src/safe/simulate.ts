import {
  concat,
  decodeErrorResult,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  pad,
  parseAbi,
  slice,
  toHex,
  zeroAddress,
  type PublicClient,
} from 'viem'
import type { Address, ChainConfig, Hex, SafeTxRecord } from '../types.ts'
import { safeAbi } from './abi.ts'
import { readSafe } from './onchain.ts'

export const NATIVE_TRANSFER_LOG_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'))
const APPROVAL_TOPIC = keccak256(toHex('Approval(address,address,uint256)'))
const NONCE_SLOT = 5n
const APPROVED_HASHES_SLOT = 8n
const SETUP_SLOTS = {
  singleton: 0n,
  guard: BigInt(keccak256(toHex('guard_manager.guard.address'))),
  fallbackHandler: BigInt(keccak256(toHex('fallback_manager.handler.address'))),
}

const setupAbi = parseAbi([
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
])

export interface SimTokenChange {
  token: Address | 'native'
  symbol: string | null
  decimals: number | null
  listed: boolean
  amount: bigint
}

export interface SimAccountDelta {
  address: Address
  isSafe: boolean
  changes: SimTokenChange[]
}

export interface SimApproval {
  token: Address
  symbol: string | null
  decimals: number | null
  listed: boolean
  spender: Address
  amount: bigint
  unlimited: boolean
}

export interface SafeSetupState {
  owners: Address[]
  threshold: bigint
  modules: Address[]
  singleton: Address | null
  guard: Address | null
  fallbackHandler: Address | null
}

export interface SimulationResult {
  mode: 'full' | 'outcome-only'
  success: boolean
  revertReason: string | null
  nonceOverridden: boolean
  deltas: SimAccountDelta[]
  approvals: SimApproval[]
  setupChanges: string[]
  at: string
}

interface RpcLog {
  address: string
  topics: Hex[]
  data: Hex
}

interface RpcCall {
  status: Hex
  returnData: Hex
  logs?: RpcLog[]
  error?: { message?: string; data?: Hex }
}

const word = (value: bigint | Address) => (typeof value === 'bigint' ? pad(toHex(value), { size: 32 }) : pad(value, { size: 32 }))

export const approvedHashSlot = (owner: Address, hash: Hex): Hex =>
  keccak256(concat([hash, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, APPROVED_HASHES_SLOT]))]))

export const approvedHashSignatures = (owners: Address[]): Hex =>
  concat([...owners].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((owner) => concat([word(owner), word(0n), '0x01'])))

const topicAddress = (topic: Hex | undefined) => getAddress(slice(topic ?? word(0n), 12))

const slotAddress = (value: Hex) => {
  const raw = BigInt(value === '0x' ? 0 : value)
  return raw === 0n ? null : getAddress(slice(word(raw), 12))
}

const erc20MetadataAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

const tokenInfo = (chain: ChainConfig, token: Address | 'native') => {
  if (token === 'native') return { symbol: chain.nativeSymbol, decimals: 18, listed: true }
  const listed = chain.tokens.find((candidate) => candidate.address.toLowerCase() === token.toLowerCase())
  return listed ? { symbol: listed.symbol, decimals: listed.decimals, listed: true } : { symbol: null, decimals: null, listed: false }
}

const readMetadata = async (client: PublicClient, token: Address) => {
  const [symbol, decimals] = await Promise.all(
    (['symbol', 'decimals'] as const).map((functionName) =>
      client.readContract({ address: token, abi: erc20MetadataAbi, functionName }).catch(() => null),
    ),
  )
  return {
    symbol: typeof symbol === 'string' && symbol.trim() ? symbol.trim().slice(0, 24) : null,
    decimals: typeof decimals === 'number' && decimals <= 36 ? decimals : null,
  }
}

export const withUnlistedMetadata = async (client: PublicClient, effects: Pick<SimulationResult, 'deltas' | 'approvals'>) => {
  const unlisted = new Set<Address>()
  for (const delta of effects.deltas)
    for (const change of delta.changes) if (!change.listed && change.token !== 'native') unlisted.add(change.token)
  for (const approval of effects.approvals) if (!approval.listed) unlisted.add(approval.token)
  const metadata = new Map(await Promise.all([...unlisted].map(async (token) => [token, await readMetadata(client, token)] as const)))
  const fill = <T extends { token: Address | 'native'; listed: boolean }>(item: T): T =>
    item.listed || item.token === 'native' ? item : { ...item, ...metadata.get(item.token) }
  return {
    deltas: effects.deltas.map((delta) => ({ ...delta, changes: delta.changes.map(fill) })),
    approvals: effects.approvals.map(fill),
  }
}

export const effectsFromLogs = (logs: RpcLog[], safe: Address, chain: ChainConfig) => {
  const totals = new Map<string, Map<string, bigint>>()
  const add = (account: Address, token: string, amount: bigint) => {
    const byToken = totals.get(account) ?? new Map<string, bigint>()
    byToken.set(token, (byToken.get(token) ?? 0n) + amount)
    totals.set(account, byToken)
  }
  const approvals: SimApproval[] = []
  for (const log of logs) {
    const [topic, first, second] = log.topics
    if (log.topics.length !== 3 || log.data === '0x') continue
    const amount = BigInt(log.data)
    if (topic === TRANSFER_TOPIC) {
      const token = log.address.toLowerCase() === NATIVE_TRANSFER_LOG_ADDRESS ? 'native' : getAddress(log.address)
      add(topicAddress(first), token, -amount)
      add(topicAddress(second), token, amount)
    } else if (topic === APPROVAL_TOPIC && topicAddress(first).toLowerCase() === safe.toLowerCase()) {
      const token = getAddress(log.address)
      approvals.push({ token, ...tokenInfo(chain, token), spender: topicAddress(second), amount, unlimited: amount >= maxUint256 / 2n })
    }
  }
  const deltas: SimAccountDelta[] = [...totals]
    .map(([address, byToken]) => ({
      address: address as Address,
      isSafe: address.toLowerCase() === safe.toLowerCase(),
      changes: [...byToken]
        .filter(([, amount]) => amount !== 0n)
        .map(([token, amount]) => ({ token: token as Address | 'native', ...tokenInfo(chain, token as Address | 'native'), amount })),
    }))
    .filter((delta) => delta.changes.length > 0)
    .sort((a, b) => Number(b.isSafe) - Number(a.isSafe) || a.address.localeCompare(b.address))
  return { deltas, approvals }
}

const setupCalls = (safe: Address, from: Address) => [
  { from, to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'getOwners' }) },
  { from, to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'getThreshold' }) },
  { from, to: safe, data: encodeFunctionData({ abi: setupAbi, functionName: 'getModulesPaginated', args: ['0x0000000000000000000000000000000000000001', 10n] }) },
  ...Object.values(SETUP_SLOTS).map((slot) => ({
    from,
    to: safe,
    data: encodeFunctionData({ abi: setupAbi, functionName: 'getStorageAt', args: [slot, 1n] }),
  })),
]

const decodeSetup = (calls: RpcCall[]): SafeSetupState => {
  const [owners, threshold, modules, singleton, guard, fallbackHandler] = calls.map((call) => call.returnData)
  const storage = (data: Hex | undefined) => slotAddress(decodeFunctionResult({ abi: setupAbi, functionName: 'getStorageAt', data: data! }))
  return {
    owners: [...decodeFunctionResult({ abi: safeAbi, functionName: 'getOwners', data: owners! })],
    threshold: decodeFunctionResult({ abi: safeAbi, functionName: 'getThreshold', data: threshold! }),
    modules: [...decodeFunctionResult({ abi: setupAbi, functionName: 'getModulesPaginated', data: modules! })[0]],
    singleton: storage(singleton),
    guard: storage(guard),
    fallbackHandler: storage(fallbackHandler),
  }
}

const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

export const setupChanges = (before: SafeSetupState, after: SafeSetupState): string[] => {
  const has = (list: Address[], address: Address) => list.some((item) => same(item, address))
  const changes = [
    ...after.owners.filter((owner) => !has(before.owners, owner)).map((owner) => `Adds owner ${owner}`),
    ...before.owners.filter((owner) => !has(after.owners, owner)).map((owner) => `Removes owner ${owner}`),
    ...(before.threshold !== after.threshold ? [`Changes the threshold from ${before.threshold} to ${after.threshold}`] : []),
    ...after.modules.filter((module) => !has(before.modules, module)).map((module) => `Enables module ${module}, which can move funds without signatures`),
    ...before.modules.filter((module) => !has(after.modules, module)).map((module) => `Disables module ${module}`),
    ...(!same(before.singleton, after.singleton) ? [`Replaces the Safe code ${before.singleton ?? 'none'} with ${after.singleton ?? 'none'}`] : []),
    ...(!same(before.guard, after.guard) ? [`Sets the transaction guard to ${after.guard ?? 'none'}`] : []),
    ...(!same(before.fallbackHandler, after.fallbackHandler)
      ? [`Changes the fallback handler to ${after.fallbackHandler ?? 'none'}`]
      : []),
  ]
  return changes
}

export const revertReason = (data: Hex | undefined, message?: string): string => {
  if (data && data !== '0x') {
    try {
      const decoded = decodeErrorResult({ abi: parseAbi(['error Error(string)']), data })
      return String(decoded.args[0])
    } catch {
      return `reverted with ${data.length > 74 ? `${data.slice(0, 74)}…` : data}`
    }
  }
  return message || 'reverted without a reason'
}

const isUnsupported = (error: unknown) =>
  /not (found|supported|available)|does not exist|unsupported|method.*eth_simulateV1/i.test(
    error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ''}` : String(error),
  )

export const simulateSafeTx = async (client: PublicClient, record: SafeTxRecord, chain: ChainConfig): Promise<SimulationResult> => {
  const safe = record.safeAddress
  const onchain = await readSafe(client, safe)
  const approvers = [...onchain.owners].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, onchain.threshold)
  const executor = approvers[0] ?? zeroAddress
  const nonceOverridden = BigInt(record.tx.nonce) !== onchain.nonce
  const stateDiff: Record<string, Hex> = Object.fromEntries(approvers.map((owner) => [approvedHashSlot(owner, record.id), word(1n)]))
  if (nonceOverridden) stateDiff[word(NONCE_SLOT)] = word(BigInt(record.tx.nonce))
  const exec = {
    from: executor,
    to: safe,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        record.tx.to,
        BigInt(record.tx.value),
        record.tx.data,
        record.tx.operation,
        BigInt(record.tx.safeTxGas),
        BigInt(record.tx.baseGas),
        BigInt(record.tx.gasPrice),
        record.tx.gasToken,
        record.tx.refundReceiver,
        approvedHashSignatures(approvers),
      ],
    }),
  }
  const at = new Date().toISOString()

  let calls: RpcCall[]
  try {
    const [block] = (await client.request({
      method: 'eth_simulateV1' as never,
      params: [
        {
          blockStateCalls: [
            {
              stateOverrides: { [safe]: { stateDiff } },
              calls: [...setupCalls(safe, executor), exec, ...setupCalls(safe, executor)],
            },
          ],
          traceTransfers: true,
          validation: false,
        },
        'latest',
      ] as never,
    })) as unknown as { calls: RpcCall[] }[]
    calls = block!.calls
  } catch (error) {
    if (!isUnsupported(error)) throw error
    try {
      const result = await client.call({
        account: executor,
        to: safe,
        data: exec.data,
        stateOverride: [{ address: safe, stateDiff: Object.entries(stateDiff).map(([slot, value]) => ({ slot: slot as Hex, value })) }],
      })
      const success = !!result.data && decodeFunctionResult({ abi: safeAbi, functionName: 'execTransaction', data: result.data })
      return { mode: 'outcome-only', success, revertReason: success ? null : 'the Safe reported failure', nonceOverridden, deltas: [], approvals: [], setupChanges: [], at }
    } catch (callError) {
      const data = (callError as { data?: Hex; cause?: { data?: Hex } }).data ?? (callError as { cause?: { data?: Hex } }).cause?.data
      return {
        mode: 'outcome-only',
        success: false,
        revertReason: revertReason(data, callError instanceof Error ? callError.message.split('\n')[0] : undefined),
        nonceOverridden,
        deltas: [],
        approvals: [],
        setupChanges: [],
        at,
      }
    }
  }

  const reads = setupCalls(safe, executor).length
  const execCall = calls[reads]!
  const success =
    execCall.status === '0x1' && decodeFunctionResult({ abi: safeAbi, functionName: 'execTransaction', data: execCall.returnData })
  if (!success)
    return {
      mode: 'full',
      success,
      revertReason: revertReason(execCall.returnData ?? execCall.error?.data, execCall.error?.message),
      nonceOverridden,
      deltas: [],
      approvals: [],
      setupChanges: [],
      at,
    }
  const { deltas, approvals } = await withUnlistedMetadata(client, effectsFromLogs(execCall.logs ?? [], safe, chain))
  const changes = setupChanges(decodeSetup(calls.slice(0, reads)), decodeSetup(calls.slice(reads + 1)))
  return { mode: 'full', success, revertReason: null, nonceOverridden, deltas, approvals, setupChanges: changes, at }
}
