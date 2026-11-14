import { useCallback, useEffect, useRef, useState } from 'react'
import { buildActivity, findDeployBlock, scanLogs, type ChainConfig, type DeployedSafe, type SafeRecord } from '@msa/core'
import { clientFor, useStorage } from '../state/data.tsx'
import { errorMessage } from './format.ts'

const FALLBACK_LOOKBACK = 200_000n

interface SyncState {
  syncing: boolean
  progress?: number
  error?: string
  notice?: string
}

export const useActivitySync = (safe: SafeRecord | null, chain: ChainConfig | undefined) => {
  const storage = useStorage()
  const [state, setState] = useState<SyncState>({ syncing: false })
  const latestSafe = useRef(safe)
  const latestChain = useRef(chain)
  const running = useRef(false)
  latestSafe.current = safe
  latestChain.current = chain

  const sync = useCallback(async () => {
    const current = latestSafe.current
    const activeChain = latestChain.current
    if (!current?.address || !activeChain || running.current) return
    running.current = true
    setState({ syncing: true })
    try {
      const client = clientFor(activeChain)
      const latest = await client.getBlockNumber({ cacheTime: 0 })
      let notice: string | undefined
      let deployBlock = current.deployBlock
      if (!deployBlock) {
        deployBlock = await findDeployBlock(client, current.address)
          .then((block) => block.toString())
          .catch(() => {
            notice = 'This RPC has no archive data, so only recent history was loaded.'
            return (latest > FALLBACK_LOOKBACK ? latest - FALLBACK_LOOKBACK : 0n).toString()
          })
      }
      const from = current.scannedBlock ? BigInt(current.scannedBlock) + 1n : BigInt(deployBlock)

      if (from <= latest) {
        const span = Number(latest - from) || 1
        const logs = await scanLogs(client, current.address, activeChain.tokens.map((token) => token.address), from, latest, ({ toBlock }) =>
          setState({ syncing: true, progress: Math.min(1, Number(toBlock - from) / span) }),
        )
        const items = await buildActivity(client, activeChain, current as DeployedSafe, logs)
        for (const item of items) await storage.put('activity', item)
        for (const item of items) {
          if (item.kind !== 'executed' || !item.safeTxHash) continue
          const record = await storage.get('txs', item.safeTxHash)
          if (record && record.status !== 'executed') {
            await storage.put('txs', { ...record, status: 'executed', executedTxHash: record.executedTxHash ?? item.txHash })
          }
        }
      }

      const fresh = (await storage.get('safes', current.id)) ?? current
      await storage.put('safes', { ...fresh, deployBlock, scannedBlock: latest.toString(), scannedAt: new Date().toISOString() })
      setState({ syncing: false, notice })
    } catch (error) {
      setState({ syncing: false, error: errorMessage(error) })
    } finally {
      running.current = false
    }
  }, [storage])

  const safeId = safe?.id
  const chainId = chain?.chainId
  useEffect(() => {
    if (safeId && chainId) void sync()
  }, [safeId, chainId, sync])

  return { ...state, sync }
}
