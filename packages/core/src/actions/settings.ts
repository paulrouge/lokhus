import { encodeFunctionData, getAddress, isAddress } from 'viem'
import type { Address, MetaTx } from '../types.ts'
import type { ActionPlugin } from '../plugins.ts'
import { safeAbi } from '../safe/abi.ts'
import { readSafe } from '../safe/onchain.ts'

export const changeThreshold: ActionPlugin = {
  id: 'change-threshold',
  label: 'Change threshold',
  description: 'Set how many owners must sign every transaction.',
  supports: () => true,
  fields: ({ safe }) => [
    {
      name: 'threshold',
      label: `New threshold (1 to ${safe.owners.length})`,
      type: 'text',
      placeholder: String(Math.floor(safe.owners.length / 2) + 1),
      help: 'Takes effect right after this transaction executes. It still needs the current threshold of signatures.',
    },
  ],
  build: async (input, { safe, client }) => {
    const { owners, threshold: current } = await readSafe(client, safe.address)
    const threshold = Number((input.threshold ?? '').trim())
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
      throw new Error(`Threshold must be a whole number from 1 to ${owners.length}`)
    }
    if (threshold === current) throw new Error(`Threshold is already ${current}`)
    return {
      calls: [{ to: safe.address, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'changeThreshold', args: [BigInt(threshold)] }) }],
      summary: `Change threshold from ${current} of ${owners.length} to ${threshold} of ${owners.length}`,
    }
  },
}

const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001'

export const ownerChangeCalls = (
  safe: Address,
  current: { owners: Address[]; threshold: number },
  target: { owners: Address[]; threshold: number },
): MetaTx[] => {
  const has = (list: Address[], owner: Address) => list.some((candidate) => candidate.toLowerCase() === owner.toLowerCase())
  if (target.owners.length === 0) throw new Error('Keep at least one owner')
  if (target.threshold < 1 || target.threshold > target.owners.length)
    throw new Error(`Threshold must be from 1 to ${target.owners.length}`)
  const call = (data: MetaTx['data']): MetaTx => ({ to: safe, value: '0', data })
  const calls: MetaTx[] = []
  const list = [...current.owners]
  let threshold = current.threshold
  for (const owner of target.owners.filter((candidate) => !has(current.owners, candidate))) {
    calls.push(call(encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [owner, BigInt(threshold)] })))
    list.unshift(owner)
  }
  for (const owner of current.owners.filter((candidate) => !has(target.owners, candidate))) {
    const index = list.findIndex((candidate) => candidate.toLowerCase() === owner.toLowerCase())
    const prev = index === 0 ? SENTINEL_OWNERS : list[index - 1]!
    threshold = Math.min(threshold, list.length - 1)
    calls.push(call(encodeFunctionData({ abi: safeAbi, functionName: 'removeOwner', args: [prev, owner, BigInt(threshold)] })))
    list.splice(index, 1)
  }
  if (threshold !== target.threshold)
    calls.push(call(encodeFunctionData({ abi: safeAbi, functionName: 'changeThreshold', args: [BigInt(target.threshold)] })))
  return calls
}

const parseOwners = (text: string) =>
  text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((value) => {
      if (!isAddress(value)) throw new Error(`${value} is not a valid address`)
      return getAddress(value)
    })

export const matchOwners: ActionPlugin = {
  id: 'match-owners',
  label: 'Set owners and threshold',
  description: 'Make this Safe’s owners and threshold exactly match a list, for example the same Safe on another chain.',
  supports: () => true,
  fields: ({ safe }) => [
    { name: 'owners', label: 'Owners', type: 'addresses', help: 'Every owner the Safe should have.' },
    { name: 'threshold', label: 'Signatures needed', type: 'text', placeholder: String(safe.threshold) },
  ],
  build: async (input, { safe, client }) => {
    const current = await readSafe(client, safe.address)
    const target = { owners: parseOwners(input.owners ?? ''), threshold: Number((input.threshold ?? '').trim()) }
    if (new Set(target.owners.map((owner) => owner.toLowerCase())).size !== target.owners.length) throw new Error('Owners must be unique')
    const calls = ownerChangeCalls(safe.address, current, target)
    if (calls.length === 0) throw new Error('Owners and threshold already match')
    const has = (list: Address[], owner: Address) => list.some((candidate) => candidate.toLowerCase() === owner.toLowerCase())
    const added = target.owners.filter((owner) => !has(current.owners, owner)).length
    const removed = current.owners.filter((owner) => !has(target.owners, owner)).length
    const parts = [
      added && `add ${added} owner${added === 1 ? '' : 's'}`,
      removed && `remove ${removed} owner${removed === 1 ? '' : 's'}`,
      `${target.threshold} of ${target.owners.length}`,
    ].filter(Boolean)
    return { calls, summary: `Set owners: ${parts.join(', ')}` }
  },
}
