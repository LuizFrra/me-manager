import { describe, expect, it } from 'vitest'
import { emptyUsageTotals } from '../../../shared/usage'
import { formatCost, formatTokenSplit, formatTokens, formatUsageShort } from './usageFormat'

describe('formatCost', () => {
  it('shows dollars and cents, a floor for fractions of a cent, and whole dollars from $1,000', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(-1)).toBe('$0.00')
    expect(formatCost(Number.NaN)).toBe('$0.00')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0.005)).toBe('$0.01')
    expect(formatCost(3.4199)).toBe('$3.42')
    expect(formatCost(123.456)).toBe('$123.46')
    expect(formatCost(999.99)).toBe('$999.99')
    expect(formatCost(999.996)).toBe('$1,000')
    expect(formatCost(12_345.6)).toBe('$12,346')
  })
})

describe('formatTokens', () => {
  it('is compact: k, M and B with one decimal below 100', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(123_456)).toBe('123k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(45_000_000)).toBe('45M')
    expect(formatTokens(2_500_000_000)).toBe('2.5B')
  })

  it('moves to the next unit instead of showing 1000k', () => {
    expect(formatTokens(999_499)).toBe('999k')
    expect(formatTokens(999_950)).toBe('1M')
    expect(formatTokens(99_960)).toBe('100k')
  })
})

describe('usage summaries', () => {
  const t = {
    ...emptyUsageTotals(),
    cost: 3.42,
    input: 1200,
    output: 34_000,
    cacheRead: 1_000_000,
    cacheWrite5m: 100_000,
  }

  it('formats the badge text and the token split', () => {
    expect(formatUsageShort(t)).toBe('$3.42 · 1.1M tok')
    expect(formatTokenSplit(t)).toBe('Input 1.2k · Output 34k · Cache 1.1M')
  })
})
