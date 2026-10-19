import { BUDGET_RANK, budgetPercent, budgetSummary, isBudget } from '../../shared/budget'
import type { BudgetLevel, BudgetReport, BudgetStatus } from '../../shared/types'

/** A threshold notified: `warn` (80%) or `over` (100%). */
export type AlertLevel = Exclude<BudgetLevel, 'ok'>

interface SentAlert {
  /** The budget it was for: a changed budget starts afresh. */
  limit: number
  /** The highest threshold notified for that budget. */
  level: AlertLevel
}

/**
 * The budget notifications already sent, kept in budget-alerts.json so that a restart doesn't send them again.
 * See budgetCrossings.
 */
export interface SentBudgetAlerts {
  version: 1
  /** The daily budget's, for one local day (YYYY-MM-DD). */
  daily?: SentAlert & { day: string }
  /** Each task's, by task id. */
  tasks: Record<string, SentAlert>
}

/** A budget that has just reached a threshold: `status.level` is `warn` or `over`. */
export interface BudgetCrossing {
  scope: 'task' | 'daily'
  /** The task, for a task's budget. */
  taskId?: string
  status: BudgetStatus
}

export const emptySentBudgetAlerts = (): SentBudgetAlerts => ({ version: 1, tasks: {} })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isAlertLevel = (v: unknown): v is AlertLevel => v === 'warn' || v === 'over'
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

const sentAlert = (raw: unknown): SentAlert | null =>
  isRecord(raw) && isBudget(raw.limit) && isAlertLevel(raw.level) ? { limit: raw.limit, level: raw.level } : null

/** budget-alerts.json as read (so not trusted): only valid entries are kept; anything else is an empty record. */
export function normalizeSentBudgetAlerts(raw: unknown): SentBudgetAlerts {
  const sent = emptySentBudgetAlerts()
  if (!isRecord(raw) || raw.version !== 1) return sent
  const daily = sentAlert(raw.daily)
  if (daily && isRecord(raw.daily) && isDay(raw.daily.day)) sent.daily = { day: raw.daily.day, ...daily }
  if (isRecord(raw.tasks)) {
    for (const [id, value] of Object.entries(raw.tasks)) {
      const alert = sentAlert(value)
      if (alert) sent.tasks[id] = alert
    }
  }
  return sent
}

/** The local date of `now`, as YYYY-MM-DD: the day a daily budget is for. */
export const localDay = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/** How far `prev` got for the budget `status` is measured against: 0 when nothing was sent for that budget. */
const rankSent = (prev: SentAlert | undefined, status: BudgetStatus): number =>
  prev && prev.limit === status.limit ? BUDGET_RANK[prev.level] : 0

/**
 * The thresholds the budgets in `report` have reached since `sent` (what was already notified), and what is sent
 * once they are: one crossing per threshold per task, and per day for the daily budget. A poll that finds a
 * budget past both thresholds at once reports only `over`. A changed budget (another limit), or another day for
 * the daily one, starts afresh. Records of tasks no longer in `taskIds` (every task in the state, archived ones
 * included) are forgotten; a task merely missing from the report (archived, or without a budget now) keeps its
 * own. Pure: `sent` is never changed; `changed` says whether the result differs from it.
 */
export function budgetCrossings(
  report: BudgetReport,
  sent: SentBudgetAlerts,
  day: string,
  taskIds: ReadonlySet<string>,
): { crossings: BudgetCrossing[]; sent: SentBudgetAlerts; changed: boolean } {
  const crossings: BudgetCrossing[] = []
  const next: SentBudgetAlerts = { version: 1, tasks: {} }
  let changed = false

  for (const [id, prev] of Object.entries(sent.tasks)) {
    if (taskIds.has(id)) next.tasks[id] = prev
    else changed = true
  }
  for (const [id, status] of Object.entries(report.tasks)) {
    const prev = sent.tasks[id]
    if (BUDGET_RANK[status.level] > rankSent(prev, status)) {
      crossings.push({ scope: 'task', taskId: id, status })
      next.tasks[id] = { limit: status.limit, level: status.level as AlertLevel }
      changed = true
    } else if (prev && prev.limit !== status.limit) {
      delete next.tasks[id] // for another budget than the task has now
      changed = true
    }
  }

  const prevDay = sent.daily?.day === day ? sent.daily : undefined
  if (sent.daily && !prevDay) changed = true // yesterday's
  const daily = report.daily
  if (daily && BUDGET_RANK[daily.level] > rankSent(prevDay, daily)) {
    crossings.push({ scope: 'daily', status: daily })
    next.daily = { day, limit: daily.limit, level: daily.level as AlertLevel }
    changed = true
  } else if (prevDay && daily && prevDay.limit !== daily.limit) {
    changed = true
  } else if (prevDay) {
    next.daily = prevDay
  }
  return { crossings, sent: changed ? next : sent, changed }
}

/** A crossing's notification: what reached which threshold, and how much of the budget is spent. */
export function budgetNotice(crossing: BudgetCrossing, label = ''): { title: string; body: string } {
  const { status } = crossing
  const over = status.level === 'over'
  if (crossing.scope === 'daily') {
    return {
      title: over ? "Today's budget is used up" : `${budgetPercent(status)}% of today's budget used`,
      body: `${budgetSummary(status, 'daily budget')} (all tasks and folders)`,
    }
  }
  return {
    title: over ? 'Task over its budget' : `Task at ${budgetPercent(status)}% of its budget`,
    body: `${label}: ${budgetSummary(status, 'task budget')}`,
  }
}
