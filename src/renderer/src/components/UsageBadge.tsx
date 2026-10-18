import { useId } from 'react'
import type { UsagePeriod, UsageSummary } from '../../../shared/types'
import { usageTokens } from '../../../shared/usage'
import { shortcutLabel } from '../lib/shortcuts'
import { COST_LABEL, formatCost, formatTokens, formatUsageShort, SUBSCRIPTION_NOTE } from '../lib/usageFormat'

const ROWS: [UsagePeriod, string][] = [
  ['today', 'Today'],
  ['week', 'Last 7 days'],
  ['month', 'This month'],
  ['all', 'All time'],
]

/**
 * The selected task's or folder's Claude usage, all time: "$3.42 · 1.2M tok". Hovering or focusing it shows the
 * periods and the token split; clicking opens the usage view.
 */
export function UsageBadge({ usage, onOpen }: { usage: UsageSummary; onOpen: () => void }): React.JSX.Element {
  const tipId = useId()
  const all = usage.all
  return (
    <span className="usage-badge-wrap">
      <button
        className="usage-badge"
        aria-label={`Claude usage: ${formatUsageShort(all)}`}
        aria-describedby={tipId}
        onClick={onOpen}
      >
        <span className="usage-badge-cost">{formatCost(all.cost)}</span>
        <span className="usage-badge-sep" aria-hidden="true">
          ·
        </span>
        <span className="usage-badge-tokens">{formatTokens(usageTokens(all))} tok</span>
      </button>
      <div role="tooltip" id={tipId} className="usage-tip">
        <div className="usage-tip-title">{COST_LABEL}</div>
        <table className="usage-tip-periods">
          <tbody>
            {ROWS.map(([period, label]) => (
              <tr key={period}>
                <th scope="row">{label}</th>
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
