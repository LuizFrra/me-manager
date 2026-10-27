import { useId } from 'react'
import { budgetPercent, budgetSummary } from '../../../shared/budget'
import { USAGE_PERIODS, type BudgetStatus, type UsageSummary } from '../../../shared/types'
import { usageTokens } from '../../../shared/usage'
import { shortcutLabel } from '../lib/shortcuts'
import {
  COST_LABEL,
  formatCost,
  formatTokens,
  formatUsageShort,
  PERIOD_LABEL,
  SUBSCRIPTION_NOTE,
} from '../lib/usageFormat'

/** What the badge's name adds for a budget at 80% or more. */
const budgetNote = (budget: BudgetStatus): string =>
  budget.level === 'over'
    ? ', over its budget'
    : budget.level === 'warn'
      ? `, ${budgetPercent(budget)}% of its budget`
      : ''

/**
 * The selected task's or folder's Claude usage, all time: "$3.42 · 1.2M tok". Hovering or focusing it shows the
 * periods and the token split; clicking opens the usage view. With a budget, the tooltip says how much of it is
 * spent, and the badge turns amber from 80% of it (`budget-warn`) and red from 100% (`budget-over`).
 */
export function UsageBadge({
  usage,
  budget,
  onOpen,
}: {
  usage: UsageSummary
  /** The task's budget, against its all-time cost; null or absent when it has none. */
  budget?: BudgetStatus | null
  onOpen: () => void
}): React.JSX.Element {
  const tipId = useId()
  const all = usage.all
  const level = budget && budget.level !== 'ok' ? ` budget-${budget.level}` : ''
  return (
    <span className="usage-badge-wrap">
      <button
        className={`usage-badge${level}`}
        aria-label={`Claude usage: ${formatUsageShort(all)}${budget ? budgetNote(budget) : ''}`}
        aria-describedby={tipId}
        onClick={onOpen}
      >
        {level && (
          <span className="usage-badge-alert" aria-hidden="true">
            ⚠
          </span>
        )}
        <span className="usage-badge-cost">{formatCost(all.cost)}</span>
        <span className="usage-badge-sep" aria-hidden="true">
          ·
        </span>
        <span className="usage-badge-tokens">{formatTokens(usageTokens(all))} tok</span>
      </button>
      <div role="tooltip" id={tipId} className="usage-tip">
        <div className="usage-tip-title">{COST_LABEL}</div>
        {budget && (
          <p className={`usage-tip-budget budget-${budget.level}`}>
            {budgetSummary(budget, 'task budget')} ({budgetPercent(budget)}%)
          </p>
        )}
        <table className="usage-tip-periods">
          <tbody>
            {USAGE_PERIODS.map((period) => (
              <tr key={period}>
                <th scope="row">{PERIOD_LABEL[period]}</th>
                <td>{formatCost(usage[period].cost)}</td>
                <td>{formatTokens(usageTokens(usage[period]))} tok</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="usage-tip-split">
          <div>
            <dt>Input</dt>
            <dd>{formatTokens(all.input)}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{formatTokens(all.output)}</dd>
          </div>
          <div>
            <dt>Cache read</dt>
            <dd>{formatTokens(all.cacheRead)}</dd>
          </div>
          <div>
            <dt>Cache write</dt>
            <dd>{formatTokens(all.cacheWrite5m + all.cacheWrite1h)}</dd>
          </div>
        </dl>
        {all.unpricedTokens > 0 && (
          <p className="usage-tip-note">
            {formatTokens(all.unpricedTokens)} tokens from unpriced models not in the cost.
          </p>
        )}
        <p className="usage-tip-note">{SUBSCRIPTION_NOTE}</p>
        <p className="usage-tip-hint">Click for all tasks and folders ({shortcutLabel('usage')})</p>
      </div>
    </span>
  )
}
