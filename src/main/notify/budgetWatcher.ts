import { targetKey } from '../../shared/naming'
import { allTargets } from '../../shared/targets'
import type { AppState, BudgetAlert, BudgetReport, Settings } from '../../shared/types'
import type { BudgetAlertStoreApi } from '../store/budgetAlerts'
import { budgetCrossings, budgetNotice, localDay, type AlertLevel, type SentBudgetAlerts } from './budgetAlerts'
import type { DesktopNotice } from './watcher'

/**
 * How often the budgets are checked. Each check reads the usage the app already keeps (see getBudgets), which
 * stats the transcripts again: far more often than this isn't worth it, for costs that move by cents.
 */
export const BUDGET_CHECK_MS = 45_000

export interface BudgetWatcherDeps {
  getBudgets(): Promise<BudgetReport>
  getState(): Promise<AppState>
  getSettings(): Settings
  isWindowFocused(): boolean
  notify(notice: DesktopNotice): void
  /** Tells the renderer, to show the alert as a toast too (only while the window is focused). */
  showInApp(alert: BudgetAlert): void
  /** Where the notifications already sent are kept across restarts. */
  store: BudgetAlertStoreApi
  now?: () => Date
}

/**
 * Checks the budgets every BUDGET_CHECK_MS in the main process, while Settings.notifications is on, and sends a
 * desktop notification (and, while the window is focused, an in-app toast) for each threshold budgetCrossings
 * reports: 80% and 100% of a task's budget, once each per task and budget, and of the daily budget, once each
 * per day. What was sent is saved before notifying, so a restart doesn't repeat it. Archived tasks are never
 * checked (getBudgets leaves them out).
 */
export class BudgetWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private sent: SentBudgetAlerts | null = null
  private readonly now: () => Date

  constructor(private readonly deps: BudgetWatcherDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** One check. Never throws: a failed check just waits for the next one. */
  async tick(): Promise<void> {
    try {
      if (!this.deps.getSettings().notifications) return
      const report = await this.deps.getBudgets()
      const state = await this.deps.getState()
      this.sent ??= await this.deps.store.load()
      const taskIds = new Set<string>()
      for (const theme of state.themes)
        for (const item of theme.items) if (item.kind === 'repo') for (const task of item.tasks) taskIds.add(task.id)
      const result = budgetCrossings(report, this.sent, localDay(this.now()), taskIds)
      if (!result.changed) return
      // Kept in memory even if the save fails, so this run never repeats a notification either way.
      this.sent = result.sent
      await this.deps.store.save(result.sent).catch((err: unknown) => console.warn('budget alerts not saved:', err))
      const entries = new Map(allTargets(state).map((e) => [targetKey(e.target), e]))
      const focused = this.deps.isWindowFocused()
      for (const crossing of result.crossings) {
        const entry = crossing.taskId === undefined ? undefined : entries.get(crossing.taskId)
        if (crossing.scope === 'task' && !entry) continue // removed or archived meanwhile
        const { title, body } = budgetNotice(crossing, entry?.label)
        this.deps.notify({ title, body, ...(entry ? { target: entry.target } : {}) })
        const level = crossing.status.level as AlertLevel
        if (focused) this.deps.showInApp({ title, body, level, ...(entry ? { target: entry.target } : {}) })
      }
    } catch {
      // The usage or the state may be briefly unavailable; try again next time
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const loop = async (): Promise<void> => {
      await this.tick()
      if (this.stopped) return
      this.timer = setTimeout(() => void loop(), BUDGET_CHECK_MS)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
