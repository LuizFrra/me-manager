import { Folder, GitBranch } from 'lucide-react'
import { ICON } from '../lib/icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PRICING_SOURCE_DATE } from '../../../shared/pricing'
import { budgetPercent, budgetSummary } from '../../../shared/budget'
import { targetKey } from '../../../shared/naming'
import type {
  BudgetReport,
  BudgetStatus,
  MeManagerApi,
  Target,
  UsageBucket,
  UsagePeriod,
  UsageReport,
  UsageThemeReport,
  UsageTotals,
} from '../../../shared/types'
import { USAGE_PERIODS } from '../../../shared/types'
import { usageCacheTokens, usageTokens } from '../../../shared/usage'
import { keepIfEqual } from '../lib/keepIfEqual'
import { cleanError } from '../lib/toasts'
import { useRestoreFocus } from '../lib/useRestoreFocus'
import { COST_LABEL, formatCost, formatTokens, PERIOD_LABEL, SUBSCRIPTION_NOTE } from '../lib/usageFormat'
import { startVisibleInterval } from '../lib/visibleInterval'

/** The report is re-read this often while the view is open. */
export const USAGE_VIEW_POLL_MS = 10_000

/** What each period covers; the buttons say PERIOD_LABEL, as the header badge does. */
const PERIOD_TITLE: Record<UsagePeriod, string> = {
  today: 'Since midnight',
  week: 'The last 7 days, today included',
  month: 'Since the 1st of this month',
  all: 'Everything in the transcripts Claude Code still keeps',
}

type SortKey = 'name' | 'tokens' | 'cost'
interface Sort {
  key: SortKey
  desc: boolean
}

/** A sorted copy of `items`; ties on cost fall back to tokens. */
function sortBy<T>(items: readonly T[], sort: Sort, name: (x: T) => string, totals: (x: T) => UsageTotals): T[] {
  const diff = (a: T, b: T): number => {
    if (sort.key === 'name') return name(a).localeCompare(name(b))
    const ta = totals(a)
    const tb = totals(b)
    const tokens = usageTokens(ta) - usageTokens(tb)
    return sort.key === 'tokens' ? tokens : ta.cost - tb.cost || tokens
  }
  return [...items].sort((a, b) => (sort.desc ? -diff(a, b) : diff(a, b)))
}

function SortHeader(props: {
  label: string
  sortKey: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
  numeric?: boolean
}): React.JSX.Element {
  const active = props.sort.key === props.sortKey
  return (
    <th
      scope="col"
      className={props.numeric ? 'num' : undefined}
      aria-sort={active ? (props.sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button className={`usage-sort${active ? ' active' : ''}`} onClick={() => props.onSort(props.sortKey)}>
        {props.label}
        <span aria-hidden="true">{active ? (props.sort.desc ? ' ▾' : ' ▴') : ''}</span>
      </button>
    </th>
  )
}

/** Input, output, cache and total tokens, then the cost: the numeric cells every table row shares. */
function NumberCells({ t, priced = true }: { t: UsageTotals; priced?: boolean }): React.JSX.Element {
  return (
    <>
      <td className="num">{formatTokens(t.input)}</td>
      <td className="num">{formatTokens(t.output)}</td>
      <td
        className="num"
        title={`Read ${t.cacheRead.toLocaleString('en-US')} · written ${(t.cacheWrite5m + t.cacheWrite1h).toLocaleString('en-US')}`}
      >
        {formatTokens(usageCacheTokens(t))}
      </td>
      <td className="num">{formatTokens(usageTokens(t))}</td>
      <td className="num usage-cost-cell">
        {priced ? formatCost(t.cost) : <span className="usage-unpriced">unpriced</span>}
      </td>
    </>
  )
}

function TargetRows(props: {
  theme: UsageThemeReport
  period: UsagePeriod
  sort: Sort
  onOpenTarget: (target: Target) => void
}): React.JSX.Element {
  const { targets } = props.theme
  const used = sortBy(
    targets.filter((t) => t.usage[props.period].messages > 0),
    props.sort,
    (t) => t.label,
    (t) => t.usage[props.period],
  )
  const unused = targets.length - used.length
  const empty =
    targets.length === 0
      ? 'No tasks or folders'
      : used.length === 0
        ? 'No usage in this period'
        : unused > 0
          ? `${unused} more without usage in this period`
          : null
  return (
    <>
      {used.map((t) => (
        <tr key={t.target.taskId ?? t.target.itemId} className="usage-target-row">
          <td>
            <button
              className="usage-target"
              title={`Open ${t.label} (${t.path})`}
              onClick={() => props.onOpenTarget(t.target)}
            >
              <span className="usage-kind" aria-hidden="true">
                {t.kind === 'task' ? <GitBranch {...ICON} size={12} /> : <Folder {...ICON} size={12} />}
              </span>
              {t.label}
            </button>
          </td>
          <NumberCells t={t.usage[props.period]} />
        </tr>
      ))}
      {empty && (
        <tr className="usage-unused-row">
          <td colSpan={6}>{empty}</td>
        </tr>
      )}
    </>
  )
}

function Totals({ bucket }: { bucket: UsageBucket }): React.JSX.Element {
  const stat = (label: string, value: string, title?: string): React.JSX.Element => (
    <div className="usage-stat" title={title}>
      <div className="usage-stat-value">{value}</div>
      <div className="usage-stat-label">{label}</div>
    </div>
  )
  return (
    <section className="usage-totals" aria-label="Totals">
      <div className="usage-stat usage-stat-main">
        <div className="usage-stat-value">
          {formatCost(bucket.cost)}
          <sup aria-hidden="true">*</sup>
        </div>
        <div className="usage-stat-label">{COST_LABEL}</div>
      </div>
      {stat('Tokens', formatTokens(usageTokens(bucket)), usageTokens(bucket).toLocaleString('en-US'))}
      {stat('Input', formatTokens(bucket.input), bucket.input.toLocaleString('en-US'))}
      {stat('Output', formatTokens(bucket.output), bucket.output.toLocaleString('en-US'))}
      {stat('Cache read', formatTokens(bucket.cacheRead), bucket.cacheRead.toLocaleString('en-US'))}
      {stat(
        'Cache write',
        formatTokens(bucket.cacheWrite5m + bucket.cacheWrite1h),
        `5-minute writes ${bucket.cacheWrite5m.toLocaleString('en-US')} · 1-hour writes ${bucket.cacheWrite1h.toLocaleString('en-US')}`,
      )}
      {stat('Messages', bucket.messages.toLocaleString('en-US'))}
      {stat('Sessions', bucket.sessions.toLocaleString('en-US'))}
    </section>
  )
}

/** One budget as a bar: how much of it is spent (full once it is over), with the amounts beside it. */
function BudgetBar(props: { label: string; status: BudgetStatus; noun: string }): React.JSX.Element {
  const { status } = props
  const percent = budgetPercent(status)
  const text = `${budgetSummary(status, props.noun)} (${percent}%)`
  return (
    <li className="usage-budget">
      <span className="usage-budget-label">{props.label}</span>
      <div
        className={`usage-budget-bar budget-${status.level}`}
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
        aria-valuetext={text}
      >
        <div className="usage-budget-fill" style={{ width: `${Math.min(100, status.fraction * 100)}%` }} />
      </div>
      <span className="usage-budget-amount" aria-hidden="true">
        {text}
      </span>
    </li>
  )
}

/**
 * The daily budget (all usage today) and each task's budget (its all-time cost), the closest to its limit first;
 * how to set them when there are none.
 */
function Budgets(props: { budgets: BudgetReport; report: UsageReport; onOpenSettings: () => void }): React.JSX.Element {
  const { budgets, report } = props
  const labels = new Map(
    report.themes.flatMap((theme) => theme.targets.map((t) => [targetKey(t.target), `${theme.name} › ${t.label}`])),
  )
  const tasks = Object.entries(budgets.tasks)
    .filter(([id]) => labels.has(id))
    .sort(([, a], [, b]) => b.fraction - a.fraction)
  return (
    <section className="usage-budgets" aria-label="Budgets">
      <h3 className="usage-section-title">Budgets</h3>
      {!budgets.daily && tasks.length === 0 ? (
        <p className="usage-empty">
          No budgets set.{' '}
          <button className="link-button" onClick={props.onOpenSettings}>
            Set budgets in Settings
          </button>
        </p>
      ) : (
        <ul className="usage-budget-list">
          {budgets.daily && (
            <BudgetBar label="Today, all tasks and folders" status={budgets.daily} noun="daily budget" />
          )}
          {tasks.map(([id, status]) => (
            <BudgetBar key={id} label={labels.get(id)!} status={status} noun="task budget" />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Claude usage of every task and folder: totals, a table per theme and a per-model breakdown, for one period at
 * a time, with the budgets. Costs are estimates at API prices. Esc, the ✕ button or a click outside closes it.
 */
export function UsageView(props: {
  api: Pick<MeManagerApi, 'getUsageReport' | 'getBudgets'>
  onClose: () => void
  onOpenTarget: (target: Target) => void
  /** Closes the view for the Settings dialog, where the budgets are set. */
  onOpenSettings: () => void
}): React.JSX.Element {
  const { api } = props
  const ref = useRef<HTMLDivElement>(null)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [budgets, setBudgets] = useState<BudgetReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<UsagePeriod>('month')
  const [sort, setSort] = useState<Sort>({ key: 'cost', desc: true })
  useRestoreFocus()
  useEffect(() => ref.current?.focus(), [])

  const load = useCallback(
    () =>
      // Together, so both come from one scan of the transcripts.
      Promise.all([
        api.getUsageReport().then(
          (next) => {
            // generatedAt changes every call; only re-render when the numbers do.
            setReport((prev) => (prev ? keepIfEqual({ ...next, generatedAt: prev.generatedAt })(prev) : next))
            setError(null)
          },
          (err: unknown) => setError(cleanError(err)),
        ),
        api.getBudgets().then(
          (next) => setBudgets((prev) => (prev ? keepIfEqual(next)(prev) : next)),
          () => {}, // the bars keep their last values
        ),
      ]),
    [api],
  )
  useEffect(() => {
    void load()
    return startVisibleInterval(load, USAGE_VIEW_POLL_MS)
  }, [load])

  const onSort = (key: SortKey): void =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }))

  const total = report?.total[period]
  const themes = report
    ? sortBy(
        report.themes,
        sort,
        (t) => t.name,
        (t) => t.usage[period],
      )
    : []
  const unpriced = total?.models.filter((m) => !m.priced) ?? []

  return (
    <div className="overlay usage-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        className="usage-view"
        role="dialog"
        aria-modal="true"
        aria-label="Claude usage"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          props.onClose()
        }}
      >
        <div className="usage-header">
          <h2>Claude usage</h2>
          <div className="usage-periods" role="group" aria-label="Period">
            {USAGE_PERIODS.map((p) => (
              <button
                key={p}
                aria-pressed={period === p}
                className={period === p ? 'active' : undefined}
                title={PERIOD_TITLE[p]}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          <button className="help-close" aria-label="Close usage" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="usage-body">
          {error && (
            <p className="usage-error" role="alert">
              Could not read the usage: {error}
            </p>
          )}
          {!report && !error && <p className="usage-empty">Reading Claude Code transcripts…</p>}
          {report && total && (
            <>
              <Totals bucket={total} />
              {budgets && (
                <Budgets
                  budgets={budgets}
                  report={report}
                  onOpenSettings={() => {
                    props.onClose()
                    props.onOpenSettings()
                  }}
                />
              )}
              {unpriced.length > 0 && (
                <p className="usage-note" role="note">
                  Unpriced models: {unpriced.map((m) => m.model).join(', ')}. {formatTokens(total.unpricedTokens)} of
                  their tokens are counted but not included in the cost.
                </p>
              )}
              {themes.length === 0 && <p className="usage-empty">No themes yet: create one from the sidebar.</p>}
              {themes.length > 0 && (
                <table className="usage-table" aria-label="Usage by task and folder">
                  <thead>
                    <tr>
                      <SortHeader label="Theme / task or folder" sortKey="name" sort={sort} onSort={onSort} />
                      <th scope="col" className="num">
                        Input
                      </th>
                      <th scope="col" className="num">
                        Output
                      </th>
                      <th scope="col" className="num">
                        Cache
                      </th>
                      <SortHeader label="Tokens" sortKey="tokens" sort={sort} onSort={onSort} numeric />
                      <SortHeader label="Est. cost*" sortKey="cost" sort={sort} onSort={onSort} numeric />
                    </tr>
                  </thead>
                  {themes.map((theme) => (
                    <tbody key={theme.themeId} aria-label={theme.name}>
                      <tr className="usage-theme-row">
                        <th scope="rowgroup">{theme.name}</th>
                        <NumberCells t={theme.usage[period]} />
                      </tr>
                      <TargetRows
                        theme={theme}
                        period={period}
                        sort={sort}
                        onOpenTarget={(t) => {
                          props.onClose()
                          props.onOpenTarget(t)
                        }}
                      />
                    </tbody>
                  ))}
                </table>
              )}
              {total.models.length > 0 && (
                <>
                  <h3 className="usage-section-title">By model</h3>
                  <table className="usage-table usage-models" aria-label="Usage by model">
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        <th scope="col" className="num">
                          Input
                        </th>
                        <th scope="col" className="num">
                          Output
                        </th>
                        <th scope="col" className="num">
                          Cache
                        </th>
                        <th scope="col" className="num">
                          Tokens
                        </th>
                        <th scope="col" className="num">
                          Est. cost*
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {total.models.map((m) => (
                        <tr key={m.model}>
                          <td className="usage-model">{m.model}</td>
                          <NumberCells t={m} priced={m.priced} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
        <p className="usage-footnote">
          * {COST_LABEL}. {SUBSCRIPTION_NOTE} API prices as of {PRICING_SOURCE_DATE}. Counted from Claude Code&apos;s
          transcripts in ~/.claude/projects, which it prunes after a while (cleanupPeriodDays).
        </p>
      </div>
    </div>
  )
}
