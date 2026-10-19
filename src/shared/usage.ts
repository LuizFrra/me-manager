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

/**
 * US dollars: "$0.00" for nothing, "<$0.01" for a fraction of a cent, cents below $1,000 ("$3.42", "$123.45"),
 * whole dollars from there on ("$1,234").
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.005) return '<$0.01'
  if (usd < 999.995) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}
