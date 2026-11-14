export interface RateRule {
  limit: number
  windowMs: number
}

export interface RateDecision {
  allowed: boolean
  retryAfterMs: number
}

export interface RateLimiter {
  hit(key: string, rule: RateRule): Promise<RateDecision>
}

export const createMemoryRateLimiter = (now: () => number = Date.now, maxKeys = 50_000): RateLimiter => {
  const windows = new Map<string, { start: number; count: number }>()

  const sweep = (at: number) => {
    for (const [key, window] of windows) if (at - window.start > 24 * 60 * 60 * 1000) windows.delete(key)
    while (windows.size >= maxKeys) windows.delete(windows.keys().next().value!)
  }

  return {
    async hit(key, rule) {
      const at = now()
      const current = windows.get(key)
      if (!current || at - current.start >= rule.windowMs) {
        if (!current && windows.size >= maxKeys) sweep(at)
        windows.set(key, { start: at, count: 1 })
        return { allowed: true, retryAfterMs: 0 }
      }
      current.count += 1
      if (current.count <= rule.limit) return { allowed: true, retryAfterMs: 0 }
      return { allowed: false, retryAfterMs: current.start + rule.windowMs - at }
    },
  }
}
