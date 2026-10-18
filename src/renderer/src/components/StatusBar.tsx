import type { TaskGitStatus } from '../../../shared/types'
import { baseSummary, plural } from '../lib/gitStatus'
import { SESSION_STATE_INFO, type SessionState } from '../lib/sessionState'
import { formatCost } from '../lib/usageFormat'
import { claudeStateText, STATUS_SUBJECT_MAX, truncate } from '../lib/statusText'

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
  /** New Claude sessions start with --dangerously-skip-permissions. */
  skipPermissions: boolean
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

/**
 * A thin bar at the bottom of the main area for the selected target, from data the app already polls. A task's
 * left side: branch (click copies it), ↑ahead ↓behind its base, uncommitted files (click opens Changes) and the
 * last commit; its right side: Claude's state, the tab count, today's cost (click opens the usage view) and a
 * warning while permission prompts are skipped. A folder shows its path and the session state.
 */
export function StatusBar(p: StatusBarProps): React.JSX.Element {
  if (!p.task) {
    return (
      <div className="status-bar" role="group" aria-label="Status bar">
        <div className="status-left">
          <span className="status-seg status-path" title={p.path}>
            <span aria-hidden="true">📁</span> {p.path}
          </span>
        </div>
        <div className="status-right">
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
          <span aria-hidden="true">⎇</span>
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
        <ClaudeState session={p.session} />
        <span className="status-seg" title="Terminal tabs in this session">
          {plural(p.tabs, 'tab')}
        </span>
        {p.todayCost !== undefined && (
          <button
            className="status-seg status-cost"
            aria-label={`Today's cost ${formatCost(p.todayCost)}: show usage`}
            title="Estimated cost today at API prices. Click for the usage view."
            onClick={p.onOpenUsage}
          >
            {formatCost(p.todayCost)} today
          </button>
        )}
        {p.skipPermissions && (
          <span
            className="status-seg status-warn"
            title="New Claude sessions start with --dangerously-skip-permissions: Claude runs commands without asking"
          >
            ⚠ skip-perms
          </span>
        )}
      </div>
    </div>
  )
}
