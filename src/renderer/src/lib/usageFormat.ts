import type { UsagePeriod, UsageTotals } from '../../../shared/types'
import { usageCacheTokens, usageTokens } from '../../../shared/usage'

export const COST_LABEL = 'Estimated cost at API prices'
export const SUBSCRIPTION_NOTE =
  "On a Pro/Max subscription you don't pay per token; this is what the same usage would cost on the API."

export const PERIOD_LABEL: Record<UsagePeriod, string> = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'This month',
  all: 'All time',
}

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

const UNITS: [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
]

/** Compact token counts: "999", "12.3k", "123k", "1.2M", "45M", "1.2B". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [size, unit] = UNITS[i]
    const value = n / size
    // One decimal below 100 ("12.3k"), none above ("123k"); a value that rounds up to 1000 moves to the next unit.
    const text = value < 99.95 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
    if (Number(text) < 1000 || i === 0) return `${text}${unit}`
  }
  return String(n) // unreachable
}

/** "$3.42 · 1.2M tok". */
export const formatUsageShort = (t: UsageTotals): string =>
  `${formatCost(t.cost)} · ${formatTokens(usageTokens(t))} tok`

/** "Input 1.2k · Output 34k · Cache 1.1M". */
export const formatTokenSplit = (t: UsageTotals): string =>
  `Input ${formatTokens(t.input)} · Output ${formatTokens(t.output)} · Cache ${formatTokens(usageCacheTokens(t))}`
