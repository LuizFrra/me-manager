import { messageCost, totalTokens, type TokenCounts } from '../../../shared/pricing'
import { budgetStatus, effectiveTaskBudget } from '../../../shared/budget'
import type {
  AppState,
  BudgetReport,
  BudgetStatus,
  Settings,
  UsageBucket,
  UsageModelTotals,
  UsagePeriod,
  UsageReport,
  UsageSummary,
  UsageTargetReport,
} from '../../../shared/types'
import { isArchived, USAGE_PERIODS } from '../../../shared/types'
import { targetKey } from '../../../shared/naming'
import { emptyUsageBucket, emptyUsageSummary } from '../../../shared/usage'

/** A small stable hash, so each demo target always shows the same numbers. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Share of the all-time usage that falls in each period. */
const SHARE: Record<UsagePeriod, number> = { today: 0.08, week: 0.3, month: 0.65, all: 1 }

function modelTotals(model: string, tokens: TokenCounts, messages: number): UsageModelTotals {
  const cost = messageCost(model, tokens)
  return {
    ...tokens,
    model,
    priced: cost !== null,
    cost: cost ?? 0,
    unpricedTokens: cost === null ? totalTokens(tokens) : 0,
    companyTokens: 0,
    messages,
    sessions: Math.max(1, Math.round(messages / 40)),
    firstSeen: '2026-09-02T09:15:00.000Z',
    lastSeen: '2026-10-18T11:42:00.000Z',
  }
}

/** Sums buckets (sessions too: fine for demo data). */
function addBuckets(buckets: UsageBucket[]): UsageBucket {
  const out = emptyUsageBucket()
  const models = new Map<string, UsageModelTotals>()
  for (const b of buckets) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) out[k] += b[k]
    out.cost += b.cost
    out.unpricedTokens += b.unpricedTokens
    out.companyTokens += b.companyTokens
    out.messages += b.messages
    out.sessions += b.sessions
    if (b.firstSeen && (!out.firstSeen || b.firstSeen < out.firstSeen)) out.firstSeen = b.firstSeen
    if (b.lastSeen && (!out.lastSeen || b.lastSeen > out.lastSeen)) out.lastSeen = b.lastSeen
    for (const m of b.models) {
      const prev = models.get(m.model)
      if (!prev) {
        models.set(m.model, { ...m })
        continue
      }
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) prev[k] += m[k]
      prev.cost += m.cost
      prev.unpricedTokens += m.unpricedTokens
      prev.companyTokens += m.companyTokens
      prev.messages += m.messages
      prev.sessions += m.sessions
    }
  }
  out.models = [...models.values()].sort((a, b) => b.cost - a.cost)
  return out
}

export function addSummaries(summaries: UsageSummary[]): UsageSummary {
  if (summaries.length === 0) return emptyUsageSummary()
  return Object.fromEntries(USAGE_PERIODS.map((p) => [p, addBuckets(summaries.map((s) => s[p]))])) as Record<
    UsagePeriod,
    UsageBucket
  >
}

/** Plausible, stable usage for a demo target; every fifth one also used a model without a known price. */
export function demoUsage(seed: string): UsageSummary {
  const h = hash(seed)
  const scale = 0.2 + (h % 1000) / 250 // 0.2 … 4.2
  const bucket = (share: number): UsageBucket => {
    const k = scale * share
    const n = (v: number): number => Math.round(v * k)
    const models: UsageModelTotals[] = [
      modelTotals(
        'claude-opus-5-5',
        { input: n(9_000), output: n(180_000), cacheRead: n(6_500_000), cacheWrite5m: 0, cacheWrite1h: n(420_000) },
        Math.max(1, n(160)),
      ),
      modelTotals(
        'claude-haiku-4-5-20251001',
        { input: n(40_000), output: n(12_000), cacheRead: n(300_000), cacheWrite5m: n(60_000), cacheWrite1h: 0 },
        Math.max(1, n(45)),
      ),
    ]
    if (h % 5 === 0)
      models.push(
        modelTotals(
          'claude-experimental-1',
          { input: n(1_000), output: n(9_000), cacheRead: n(50_000), cacheWrite5m: 0, cacheWrite1h: 0 },
          Math.max(1, n(8)),
        ),
      )
    return addBuckets([{ ...emptyUsageBucket(), models: [] }, ...models.map((m) => ({ ...m, models: [m] }))])
  }
  return Object.fromEntries(USAGE_PERIODS.map((p) => [p, bucket(SHARE[p])])) as Record<UsagePeriod, UsageBucket>
}

/** The report the mock API returns: demoUsage for every task and folder, summed per theme and overall, as Default's. */
export function demoUsageReport(state: AppState): UsageReport {
  const themes = state.themes.map((theme) => {
    const targets: UsageTargetReport[] = []
    for (const item of theme.items) {
      if (item.kind === 'folder') {
        const target = { themeId: theme.id, itemId: item.id }
        targets.push({ target, kind: 'folder', label: item.name, path: item.path, usage: demoUsage(targetKey(target)) })
        continue
      }
      for (const task of item.tasks) {
        const target = { themeId: theme.id, itemId: item.id, taskId: task.id }
        targets.push({
          target,
          kind: 'task',
          label: `${item.name} › ${task.name}`,
          path: task.worktreePath,
          usage: demoUsage(targetKey(target)),
        })
      }
    }
    return { themeId: theme.id, name: theme.name, usage: addSummaries(targets.map((t) => t.usage)), targets }
  })
  const total = addSummaries(themes.map((t) => t.usage))
  // All of it Default's, billed to the user.
  return {
    generatedAt: new Date().toISOString(),
    total,
    themes,
    profiles: [{ id: 'default', name: 'Default', billing: 'own', report: { total, themes } }],
  }
}

/** Where the demo's budgets stand, from the same numbers as demoUsageReport (as main does). */
export function demoBudgets(state: AppState, settings: Settings): BudgetReport {
  const report = demoUsageReport(state)
  const tasks: Record<string, BudgetStatus> = {}
  for (const theme of state.themes)
    for (const item of theme.items) {
      if (item.kind !== 'repo') continue
      for (const task of item.tasks) {
        const status = isArchived(task)
          ? null
          : budgetStatus(demoUsage(task.id).all.cost, effectiveTaskBudget(task, settings))
        if (status) tasks[task.id] = status
      }
    }
  return { daily: budgetStatus(report.total.today.cost, settings.dailyBudgetUsd), tasks }
}
