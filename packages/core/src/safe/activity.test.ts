import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { scanLogs } from './activity'

describe('scanLogs', () => {
  it('never asks for more than 10k blocks after shrinking and growing the range', async () => {
    const spans: bigint[] = []
    let failures = 6
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (failures-- > 0) throw new Error('timeout')
        const span = toBlock - fromBlock + 1n
        spans.push(span)
        if (span > 10_000n) throw new Error('ranges over 10000 blocks are not supported')
        return []
      },
    } as unknown as PublicClient
    await scanLogs(client, '0x0000000000000000000000000000000000000001', [], 0n, 500_000n)
    expect(spans.every((span) => span <= 10_000n)).toBe(true)
  })
})
