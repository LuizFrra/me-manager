import type { BudgetLevel, BudgetStatus } from './types'
import { formatCost } from './usage'

/** The smallest and largest budget, in USD. */
export const BUDGET_LIMITS = { min: 0.01, max: 100_000 } as const
/** The share of a budget from which it is `warn`. */
export const BUDGET_WARN_FRACTION = 0.8

/** Ordered: a higher rank is a later threshold. */
export const BUDGET_RANK: Record<BudgetLevel, number> = { ok: 0, warn: 1, over: 2 }

const BUDGET_ERROR = `The budget must be an amount from ${formatCost(BUDGET_LIMITS.min)} to ${formatCost(BUDGET_LIMITS.max)}`
const BUDGET_INPUT_ERROR = `Enter an amount from ${formatCost(BUDGET_LIMITS.min)} to ${formatCost(BUDGET_LIMITS.max)}, or leave it empty.`

const toCents = (usd: number): number => Math.round(usd * 100) / 100

const inLimits = (usd: number): boolean => usd >= BUDGET_LIMITS.min && usd <= BUDGET_LIMITS.max

/**
 * `spent` against `limit`: `ok` below BUDGET_WARN_FRACTION of it, `warn` from there, `over` once it is all spent.
 * A spend that is not a positive number counts as 0. null without a limit (absent, or not a positive number).
 */
export function budgetStatus(spent: number, limit: number | null | undefined): BudgetStatus | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  const used = Number.isFinite(spent) && spent > 0 ? spent : 0
  const fraction = used / limit
  const level: BudgetLevel = fraction >= 1 ? 'over' : fraction >= BUDGET_WARN_FRACTION ? 'warn' : 'ok'
  return { level, spent: used, limit, fraction }
}

/** The share of the budget spent, in whole percent rounded down: 100% shows only once the budget is reached. */
export const budgetPercent = (status: BudgetStatus): number => Math.floor(status.fraction * 100 + 1e-9)

/** "$4.10 of $5.00 task budget", with `noun` naming the budget. */
export const budgetSummary = (status: BudgetStatus, noun: string): string =>
  `${formatCost(status.spent)} of ${formatCost(status.limit)} ${noun}`

/**
 * A budget from the renderer (so untrusted): null or undefined for none, else a number of dollars rounded to
 * cents, within BUDGET_LIMITS. Throws for anything else.
 */
export function normalizeBudget(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(BUDGET_ERROR)
  const usd = toCents(raw)
  if (!inLimits(usd)) throw new Error(BUDGET_ERROR)
  return usd
}

/** Whether a stored value is a budget as normalizeBudget leaves it (whole cents, within BUDGET_LIMITS). */
export const isBudget = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && inLimits(value) && toCents(value) === value

/**
 * A budget as typed: dollars, optionally after "$" and with thousands separators as formatCost shows them
 * ("$1,500"); empty for none. A comma before the cents ("12,50") gets its own message rather than a misreading.
 */
export function budgetFromText(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { value: null }
  const match = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/.exec(trimmed)
  if (!match && /^\$?\d+,\d{1,2}$/.test(trimmed)) return { error: 'Use a dot for cents, e.g. 12.50.' }
  const usd = match ? toCents(Number(match[1].replaceAll(',', ''))) : NaN
  return Number.isFinite(usd) && inLimits(usd) ? { value: usd } : { error: BUDGET_INPUT_ERROR }
}

/** The text field's value for a budget: "5" or "12.50"; '' for none. */
export const budgetText = (usd: number | null | undefined): string =>
  usd === null || usd === undefined ? '' : Number.isInteger(usd) ? String(usd) : usd.toFixed(2)

/** A task's budget: its own (Task.budgetUsd), else the default per-task one (Settings.taskBudgetUsd), else none. */
export const effectiveTaskBudget = (
  task: { budgetUsd?: number },
  settings: { taskBudgetUsd: number | null },
): number | null => task.budgetUsd ?? settings.taskBudgetUsd
