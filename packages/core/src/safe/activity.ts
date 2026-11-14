import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  formatUnits,
  getAddress,
  size,
  slice,
  type Log,
  type PublicClient,
} from 'viem'
import type { ActivityItem, Address, ChainConfig, DeployedSafe, Hex } from '../types.ts'
import { erc20Abi, multiSendAbi, safeAbi, transferEvent } from './abi.ts'

const MAX_RANGE = 8_000n
const MIN_RANGE = 40n
const START_RANGE = 2_000n

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

const amount = (value: bigint, decimals: number) => {
  const [whole = '0', fraction = ''] = formatUnits(value, decimals).split('.')
  const leadingZeros = whole === '0' ? (fraction.match(/^0*/)?.[0].length ?? 0) : 0
  const trimmed = fraction.slice(0, leadingZeros + 4).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

const countMultiSendCalls = (packed: Hex) => {
  let offset = 0
  let calls = 0
  const total = size(packed)
  while (offset < total) {
    const dataLength = Number(BigInt(slice(packed, offset + 53, offset + 85)))
    offset += 85 + dataLength
    calls++
  }
  return calls
}

export const formatTokenAmount = amount

export const describeCall = (chain: ChainConfig, safe: Address, to: Address, value: bigint, data: Hex): string => {
  if (data === '0x' || size(data) === 0) return `Sent ${amount(value, 18)} ${chain.nativeSymbol} to ${short(to)}`
  if (to.toLowerCase() === safe.toLowerCase()) {
    try {
      const call = decodeFunctionData({ abi: safeAbi, data })
      if (call.functionName === 'changeThreshold') return `Changed threshold to ${call.args[0]}`
    } catch {}
    return 'Changed Safe settings'
  }

  const token = chain.tokens.find((candidate) => candidate.address.toLowerCase() === to.toLowerCase())
  try {
    const call = decodeFunctionData({ abi: erc20Abi, data })
    if (call.functionName === 'transfer') {
      const [recipient, value_] = call.args
      return token ? `Sent ${amount(value_, token.decimals)} ${token.symbol} to ${short(recipient)}` : `Token transfer to ${short(recipient)}`
    }
    if (call.functionName === 'approve') return `Approved ${token?.symbol ?? short(to)} for ${short(call.args[0])}`
  } catch {}

  try {
    const call = decodeFunctionData({ abi: multiSendAbi, data })
    return `Batch of ${countMultiSendCalls(call.args[0])} calls`
  } catch {}

  return `Contract call to ${short(to)}`
}

export const findDeployBlock = async (client: PublicClient, address: Address): Promise<bigint> => {
  let low = 0n
  let high = await client.getBlockNumber({ cacheTime: 0 })
  while (low < high) {
    const middle = (low + high) / 2n
    const code = await client.getCode({ address, blockNumber: middle })
    if (code && code !== '0x') high = middle
    else low = middle + 1n
  }
  return low
}

type RangeLogs = { safeLogs: Log[]; tokenLogs: Log[] }

const fetchRange = async (client: PublicClient, safe: Address, tokens: Address[], fromBlock: bigint, toBlock: bigint): Promise<RangeLogs> => {
  const [safeLogs, tokenLogs] = await Promise.all([
    client.getLogs({ address: safe, fromBlock, toBlock }),
    tokens.length ? client.getLogs({ address: tokens, event: transferEvent[0], args: { to: safe }, fromBlock, toBlock }) : [],
  ])
  return { safeLogs, tokenLogs }
}

export interface ScanProgress {
  fromBlock: bigint
  toBlock: bigint
  latest: bigint
}

export const scanLogs = async (
  client: PublicClient,
  safe: Address,
  tokens: Address[],
  fromBlock: bigint,
  toBlock: bigint,
  onProgress?: (progress: ScanProgress) => void,
): Promise<RangeLogs> => {
  const result: RangeLogs = { safeLogs: [], tokenLogs: [] }
  let range = START_RANGE
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const end = cursor + range - 1n > toBlock ? toBlock : cursor + range - 1n
    try {
      const chunk = await fetchRange(client, safe, tokens, cursor, end)
      result.safeLogs.push(...chunk.safeLogs)
      result.tokenLogs.push(...chunk.tokenLogs)
      onProgress?.({ fromBlock: cursor, toBlock: end, latest: toBlock })
      cursor = end + 1n
      range = range * 2n < MAX_RANGE ? range * 2n : MAX_RANGE
    } catch (error) {
      if (range <= MIN_RANGE) throw error
      range /= 2n
    }
  }
  return result
}

export const buildActivity = async (
  client: PublicClient,
  chain: ChainConfig,
  safe: DeployedSafe,
  { safeLogs, tokenLogs }: RangeLogs,
): Promise<ActivityItem[]> => {
  const blocks = new Set([...safeLogs, ...tokenLogs].map((log) => log.blockNumber!))
  const timestamps = new Map<bigint, number>()
  await Promise.all(
    [...blocks].map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber })
      timestamps.set(blockNumber, Number(block.timestamp))
    }),
  )

  const base = (log: Log) => ({
    id: `${chain.chainId}:${log.transactionHash}:${log.logIndex}`,
    safeId: safe.id,
    chainId: chain.chainId,
    blockNumber: log.blockNumber!.toString(),
    timestamp: timestamps.get(log.blockNumber!) ?? 0,
    txHash: log.transactionHash!,
    logIndex: log.logIndex!,
  })

  const details = new Map<string, { to: Address; value: bigint; data: Hex; nonce: bigint }>()
  const items: ActivityItem[] = []

  for (const log of safeLogs) {
    let event
    try {
      event = decodeEventLog({ abi: safeAbi, data: log.data, topics: log.topics })
    } catch {
      continue
    }
    if (event.eventName === 'SafeMultiSigTransaction') {
      const [nonce] = decodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], event.args.additionalInfo)
      details.set(log.transactionHash!, { to: event.args.to, value: event.args.value, data: event.args.data, nonce })
    }
  }

  for (const log of safeLogs) {
    let event
    try {
      event = decodeEventLog({ abi: safeAbi, data: log.data, topics: log.topics })
    } catch {
      continue
    }
    switch (event.eventName) {
      case 'ExecutionSuccess':
      case 'ExecutionFailure': {
        const detail = details.get(log.transactionHash!)
        const description = detail ? describeCall(chain, safe.address, detail.to, detail.value, detail.data) : 'Safe transaction'
        items.push({
          ...base(log),
          kind: event.eventName === 'ExecutionSuccess' ? 'executed' : 'failed',
          summary: event.eventName === 'ExecutionSuccess' ? description : `Failed: ${description}`,
          safeTxHash: event.args.txHash,
          nonce: detail?.nonce.toString(),
          counterparty: detail?.to,
        })
        break
      }
      case 'SafeReceived':
        items.push({
          ...base(log),
          kind: 'received',
          summary: `Received ${amount(event.args.value, 18)} ${chain.nativeSymbol} from ${short(event.args.sender)}`,
          counterparty: event.args.sender,
        })
        break
      case 'AddedOwner':
        items.push({ ...base(log), kind: 'owner-added', summary: `Added owner ${short(event.args.owner)}`, counterparty: event.args.owner })
        break
      case 'RemovedOwner':
        items.push({ ...base(log), kind: 'owner-removed', summary: `Removed owner ${short(event.args.owner)}`, counterparty: event.args.owner })
        break
      case 'ChangedThreshold':
        items.push({ ...base(log), kind: 'threshold-changed', summary: `Threshold set to ${event.args.threshold}` })
        break
    }
  }

  for (const log of tokenLogs) {
    const event = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics })
    const token = getAddress(log.address)
    const listed = chain.tokens.find((candidate) => candidate.address.toLowerCase() === token.toLowerCase())
    const hidden = !listed ? 'unlisted-token' : event.args.value === 0n ? 'zero-value' : undefined
    items.push({
      ...base(log),
      kind: 'token-received',
      summary: listed
        ? `Received ${amount(event.args.value, listed.decimals)} ${listed.symbol} from ${short(event.args.from)}`
        : `Received unlisted token ${short(token)} from ${short(event.args.from)}`,
      counterparty: event.args.from,
      token,
      amountRaw: event.args.value.toString(),
      hidden,
    })
  }

  return items
}
