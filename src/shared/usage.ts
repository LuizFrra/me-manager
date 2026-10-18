import type { UsageBucket, UsagePeriod, UsageSummary, UsageTotals } from './types'
import { USAGE_PERIODS } from './types'

export const emptyUsageTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cost: 0,
  unpricedTokens: 0,
  messages: 0,
  sessions: 0,
  firstSeen: null,
  lastSeen: null,
})

export const emptyUsageBucket = (): UsageBucket => ({ ...emptyUsageTotals(), models: [] })

export function emptyUsageSummary(): UsageSummary {
  return Object.fromEntries(USAGE_PERIODS.map((p) => [p, emptyUsageBucket()])) as Record<UsagePeriod, UsageBucket>
}

/** Every token of a total: input, output, cache reads and both kinds of cache writes. */
export const usageTokens = (t: UsageTotals): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

/** Cache reads plus cache writes. */
export const usageCacheTokens = (t: UsageTotals): number => t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
