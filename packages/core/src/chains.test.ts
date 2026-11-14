import { describe, expect, it } from 'vitest'
import { createChainClient, DEFAULT_CHAINS, explorerLink, urlProblem } from './chains.ts'

describe('chain URLs', () => {
  it.each(['https://rpc.soniclabs.com', 'http://127.0.0.1:8545', 'http://localhost:8545', 'http://[::1]:8545'])('accepts %s', (url) => {
    expect(urlProblem(url)).toBeNull()
  })

  it.each(['http://rpc.example.com', 'http://127.0.0.1.evil.com', 'ws://rpc.example.com', 'javascript:alert(1)', 'not a url'])(
    'refuses %s',
    (url) => {
      expect(urlProblem(url)).not.toBeNull()
    },
  )

  it('refuses to build a client with a plain http RPC', () => {
    expect(() => createChainClient({ ...DEFAULT_CHAINS[0]!, rpcUrls: ['http://rpc.example.com'] })).toThrow(/https/)
  })

  it('does not link to an insecure explorer', () => {
    expect(explorerLink({ ...DEFAULT_CHAINS[0]!, explorerUrl: 'http://polygonscan.com' }, 'tx', '0x1')).toBe('#')
  })
})
