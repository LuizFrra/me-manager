import { useLayoutEffect, useRef } from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { ICON } from '../lib/icon'
import { budgetPercent, budgetSummary } from '../../../shared/budget'
import type { BudgetStatus, DevUrl, TaskGitStatus } from '../../../shared/types'
import { baseSummary, plural } from '../lib/gitStatus'
import { RUN_STATE_INFO, type RunState } from '../lib/run'
import { SESSION_STATE_INFO, type SessionState } from '../lib/sessionState'
import { formatCost, formatTokens } from '../lib/usageFormat'
import { claudeStateText, STATUS_SUBJECT_MAX, truncate } from '../lib/statusText'
import { DevUrlLinks } from './DevUrlLinks'

export interface StatusBarTask {
  /** The task's branch, shown until (and unless) git reports the checked-out one. */
  branch: string
  baseRef: string
  /** The task's git status, once loaded. */
  git?: TaskGitStatus
}

export interface StatusBarProps {
  /** A repo task. Without it the bar is a folder's: its path and the session state only. */
  task?: StatusBarTask
  /** The folder's (or worktree's) path, shown for folders. */
  path: string
  session: SessionState
  /** Open terminal tabs in the session. */
  tabs: number
  /** Today's estimated Claude cost in USD, once the usage is loaded. */
  todayCost?: number
  /**
   * Today's tokens, for a target billed to a company (see UsageBadge's `company`): shown in place of the cost,
   * which it has none of, and without the daily budget, which counts own accounts only.
   */
  todayTokens?: number
  /**
   * All usage today against the daily budget (see BudgetReport.daily): today's cost turns amber from 80% of it and
   * red from 100%, and its tooltip says how much is spent. Null or absent without a daily budget.
   */
  dailyBudget?: BudgetStatus | null
  /** New Claude sessions skip permission prompts (see effectiveSessionFlags). */
  skipPermissions: boolean
  /** The session's run tab; shown (a click shows the tab) unless there is none. */
  run?: RunState
  onShowRun?: () => void
  /** Dev-server URLs printed in the session's tabs, as links opened with onOpenUrl. */
  devUrls?: readonly DevUrl[]
  onOpenUrl?: (url: string) => void
  /** Copies the branch the bar shows. */
  onCopyBranch: (branch: string) => void
  onOpenChanges: () => void
  onOpenUsage: () => void
}

function ClaudeState({ session }: { session: SessionState }): React.JSX.Element {
  const info = SESSION_STATE_INFO[session]
  return (
    <span className={`status-seg status-claude ${session}`} title={info.title}>
      <span className="status-dot" aria-hidden="true">
        {info.glyph}
      </span>
      {claudeStateText(session)}
    </span>
  )
}

function RunSegment({ run, onShow }: { run?: RunState; onShow?: () => void }): React.JSX.Element | null {
  if (!run || run === 'none') return null
  const info = RUN_STATE_INFO[run]
  return (
    <button
      className={`status-seg status-run ${run}`}
      aria-label={`Run tab ${run}: show it`}
      title={`${info.title}. Click to show it.`}
      onClick={onShow}
    >
      <span aria-hidden="true">{info.glyph}</span> {info.label}
    </button>
  )
}

/** Today's cost of the target, styled and explained by the daily budget (all usage) when there is one. */
function TodayCost(props: { cost: number; budget?: BudgetStatus | null; onOpen: () => void }): React.JSX.Element {
  const { cost, budget } = props
  const level = budget && budget.level !== 'ok' ? ` budget-${budget.level}` : ''
  const note =
    budget?.level === 'over'
      ? ', over the daily budget'
      : budget?.level === 'warn'
        ? `, ${budgetPercent(budget)}% of the daily budget`
        : ''
  const title = budget
    ? `Estimated cost today at API prices: ${formatCost(cost)} here. ${budgetSummary(budget, 'daily budget')} (${budgetPercent(budget)}%), all tasks and folders. Click for the usage view.`
    : 'Estimated cost today at API prices. Click for the usage view.'
  return (
    <button
      className={`status-seg status-cost${level}`}
      aria-label={`Today's cost ${formatCost(cost)}${note}: show usage`}
      title={title}
      onClick={props.onOpen}
    >
      {level && <span aria-hidden="true">⚠ </span>}
      {formatCost(cost)} today
    </button>
  )
}

function Links({
  urls,
  onOpen,
}: {
  urls?: readonly DevUrl[]
  onOpen?: (url: string) => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLSpanElement>(null)
  // Links that don't fit wrap to a second line the bar hides (see .status-urls): those are made inert, so Tab never
  // lands on a link nobody can see. The task header lists them all.
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const mark = (): void => {
      const shown = box.getBoundingClientRect()
      for (const link of box.querySelectorAll<HTMLElement>('a')) {
        const at = link.getBoundingClientRect()
        link.toggleAttribute('inert', at.top >= shown.bottom || at.left >= shown.right)
      }
    }
    mark()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(mark)
    observer.observe(box)
    return () => observer.disconnect()
  }, [urls])
  if (!urls?.length || !onOpen) return null
  return (
    <span ref={ref} className="status-seg status-urls">
      <DevUrlLinks urls={urls} onOpen={onOpen} className="dev-url" />
    </span>
  )
}

/**
 * A thin bar at the bottom of the main area for the selected target, from data the app already polls. A task's
 * left side: branch (click copies it), ↑ahead ↓behind its base, uncommitted files (click opens Changes) and the
 * last commit; its right side: dev-server links, the run tab's state (click shows it), Claude's state, the tab count, today's cost (click opens the usage view) and a
 * warning while permission prompts are skipped. A folder shows its path, the links, the run tab's state and the session state.
 */
export function StatusBar(p: StatusBarProps): React.JSX.Element {
  if (!p.task) {
    return (
      <div className="status-bar" role="group" aria-label="Status bar">
        <div className="status-left">
          <span className="status-seg status-path" title={p.path}>
            <Folder {...ICON} size={12} /> {p.path}
          </span>
        </div>
        <div className="status-right">
          <Links urls={p.devUrls} onOpen={p.onOpenUrl} />
          <RunSegment run={p.run} onShow={p.onShowRun} />
          <ClaudeState session={p.session} />
        </div>
      </div>
    )
  }
  const { git, baseRef } = p.task
  const branch = git && git.branch !== 'HEAD' ? git.branch : p.task.branch
  const subject = git?.lastCommit?.subject
  return (
    <div className="status-bar" role="group" aria-label="Status bar">
      <div className="status-left">
        <button
          className="status-seg status-branch"
          aria-label={`Branch ${branch}: copy`}
          title={`Copy branch name: ${branch}`}
          onClick={() => p.onCopyBranch(branch)}
        >
          <GitBranch {...ICON} size={12} />
          <span className="status-branch-name">{branch}</span>
        </button>
        {git &&
          (git.baseMissing ? (
            <span className="status-seg status-warn" title={`${baseSummary(git, baseRef)}: ahead/behind is unknown`}>
              ⚠ no base
            </span>
          ) : (
            <span className="status-seg status-base" title={baseSummary(git, baseRef)}>
              <span className={git.ahead > 0 ? 'git-ahead' : undefined}>↑{git.ahead}</span>
              <span className={git.behind > 0 ? 'git-behind' : undefined}>↓{git.behind}</span>
            </span>
          ))}
        {git && (
          <button
            className={`status-seg status-changes${git.uncommitted > 0 ? ' dirty' : ''}`}
            aria-label={`${plural(git.uncommitted, 'uncommitted file')}: show changes`}
            title="Show the changes in the side panel"
            onClick={p.onOpenChanges}
          >
            <span aria-hidden="true">●</span>
            {git.uncommitted}
          </button>
        )}
        {git?.lastCommit && subject !== undefined && (
          <span
            className="status-seg status-commit"
            title={`Last commit ${git.lastCommit.sha}, ${git.lastCommit.relativeDate}: ${subject}`}
          >
            {truncate(subject, STATUS_SUBJECT_MAX)}
          </span>
        )}
      </div>
      <div className="status-right">
        <Links urls={p.devUrls} onOpen={p.onOpenUrl} />
        <RunSegment run={p.run} onShow={p.onShowRun} />
        <ClaudeState session={p.session} />
        <span className="status-seg" title="Terminal tabs in this session">
          {plural(p.tabs, 'tab')}
        </span>
        {p.todayTokens !== undefined ? (
          <button
            className="status-seg status-cost"
            aria-label={`Today's tokens ${formatTokens(p.todayTokens)}, billed to your company: show usage`}
            title="Claude tokens today, billed to your company (no cost estimate). Click for the usage view."
            onClick={p.onOpenUsage}
          >
            {formatTokens(p.todayTokens)} tok today
          </button>
        ) : (
          p.todayCost !== undefined && <TodayCost cost={p.todayCost} budget={p.dailyBudget} onOpen={p.onOpenUsage} />
        )}
        {p.skipPermissions && (
          <span
            className="status-seg status-warn"
            title="New Claude sessions skip permission prompts (--dangerously-skip-permissions): Claude runs commands without asking"
          >
            ⚠ skip-perms
          </span>
        )}
      </div>
    </div>
  )
}
