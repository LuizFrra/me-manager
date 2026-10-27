import { describe, expect, it } from 'vitest'
import {
  BUDGET_LIMITS,
  budgetFromText,
  budgetPercent,
  budgetStatus,
  budgetSummary,
  budgetText,
  effectiveTaskBudget,
  isBudget,
  normalizeBudget,
} from './budget'

describe('budgetStatus', () => {
  it('is ok below 80%, warn from 80% and over from 100%, with the fraction', () => {
    expect(budgetStatus(1, 5)).toEqual({ level: 'ok', spent: 1, limit: 5, fraction: 0.2 })
    expect(budgetStatus(3.99, 5)?.level).toBe('ok')
    expect(budgetStatus(4, 5)).toEqual({ level: 'warn', spent: 4, limit: 5, fraction: 0.8 })
    expect(budgetStatus(4.99, 5)?.level).toBe('warn')
    expect(budgetStatus(5, 5)).toEqual({ level: 'over', spent: 5, limit: 5, fraction: 1 })
    expect(budgetStatus(12.5, 5)).toEqual({ level: 'over', spent: 12.5, limit: 5, fraction: 2.5 })
  })

  it('counts nothing spent (or a nonsense amount) as 0', () => {
    expect(budgetStatus(0, 5)).toEqual({ level: 'ok', spent: 0, limit: 5, fraction: 0 })
    expect(budgetStatus(-3, 5)).toEqual({ level: 'ok', spent: 0, limit: 5, fraction: 0 })
    expect(budgetStatus(Number.NaN, 5)).toEqual({ level: 'ok', spent: 0, limit: 5, fraction: 0 })
  })

  it('is null without a usable limit', () => {
    for (const limit of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(budgetStatus(3, limit)).toBeNull()
    }
  })
})

describe('budgetSummary / budgetPercent', () => {
  it('reads "$4.10 of $5.00 task budget"', () => {
    expect(budgetSummary(budgetStatus(4.1, 5)!, 'task budget')).toBe('$4.10 of $5.00 task budget')
    expect(budgetSummary(budgetStatus(1234.5, 1000)!, 'daily budget')).toBe('$1,235 of $1,000 daily budget')
  })

  it('rounds the percentage down, so 100% only shows once the budget is reached', () => {
    expect(budgetPercent(budgetStatus(4.999, 5)!)).toBe(99)
    expect(budgetPercent(budgetStatus(5, 5)!)).toBe(100)
    expect(budgetPercent(budgetStatus(0.41, 0.5)!)).toBe(82)
  })
})

describe('normalizeBudget / isBudget', () => {
  it('rounds to cents and keeps an amount within the limits', () => {
    expect(normalizeBudget(5)).toBe(5)
    expect(normalizeBudget(4.567)).toBe(4.57)
    expect(normalizeBudget(BUDGET_LIMITS.max)).toBe(BUDGET_LIMITS.max)
    expect(normalizeBudget(BUDGET_LIMITS.min)).toBe(BUDGET_LIMITS.min)
  })

  it('gives null for no budget', () => {
    expect(normalizeBudget(null)).toBeNull()
    expect(normalizeBudget(undefined)).toBeNull()
  })

  it('throws for anything else', () => {
    for (const bad of [0, -1, 0.004, BUDGET_LIMITS.max + 1, Number.NaN, Number.POSITIVE_INFINITY, '5', {}, true]) {
      expect(() => normalizeBudget(bad)).toThrow('The budget must be an amount from $0.01 to $100,000')
    }
  })

  it('tells a stored budget as normalizeBudget leaves it', () => {
    expect(isBudget(5)).toBe(true)
    expect(isBudget(0.01)).toBe(true)
    for (const bad of [0, -5, 4.567, BUDGET_LIMITS.max + 1, '5', null, undefined, Number.NaN]) {
      expect(isBudget(bad)).toBe(false)
    }
  })
})

describe('budgetFromText', () => {
  it('reads an amount in dollars, with or without "$", and empty as no budget', () => {
    expect(budgetFromText('5')).toEqual({ value: 5 })
    expect(budgetFromText(' $12.50 ')).toEqual({ value: 12.5 })
    expect(budgetFromText('0.333')).toEqual({ value: 0.33 })
    expect(budgetFromText('')).toEqual({ value: null })
    expect(budgetFromText('   ')).toEqual({ value: null })
  })

  it('takes thousands separators, as amounts are shown with them ("$100,000")', () => {
    expect(budgetFromText('1,000')).toEqual({ value: 1000 })
    expect(budgetFromText('$100,000')).toEqual({ value: 100_000 })
    expect(budgetFromText('1,234.5')).toEqual({ value: 1234.5 })
  })

  it('says to use a dot for cents when a comma is used for them', () => {
    for (const comma of ['12,5', '$5,50', '0,99']) {
      expect(budgetFromText(comma)).toEqual({ error: 'Use a dot for cents, e.g. 12.50.' })
    }
  })

  it('explains what it accepts otherwise', () => {
    for (const bad of ['0', '-5', 'five', '5$', '1e9', '100001', '0.001', '1,00,000', '1,0000', '100,001']) {
      expect(budgetFromText(bad)).toEqual({ error: 'Enter an amount from $0.01 to $100,000, or leave it empty.' })
    }
  })
})

describe('effectiveTaskBudget', () => {
  it("is the task's own budget, else the default per-task budget, else none", () => {
    expect(effectiveTaskBudget({ budgetUsd: 2 }, { taskBudgetUsd: 10 })).toBe(2)
    expect(effectiveTaskBudget({}, { taskBudgetUsd: 10 })).toBe(10)
    expect(effectiveTaskBudget({}, { taskBudgetUsd: null })).toBeNull()
  })
})

describe('budgetText', () => {
  it('shows a budget for its text field', () => {
    expect(budgetText(5)).toBe('5')
    expect(budgetText(12.5)).toBe('12.50')
    expect(budgetText(null)).toBe('')
    expect(budgetText(undefined)).toBe('')
  })
})
