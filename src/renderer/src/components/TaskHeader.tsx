import { useCallback, useState } from 'react'
import {
  ArrowUp,
  CircleDollarSign,
  Code,
  Copy,
  Ellipsis,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  SquareTerminal,
  StickyNote,
  UserRound,
} from 'lucide-react'
import type { BudgetStatus, DevUrl, TaskGitStatus, UpdateStrategy, UsageSummary } from '../../../shared/types'
import { GH_INSTALL_HINT } from '../../../shared/git'
import type { CopyEntry } from '../lib/copy'
import { GIT_ACTION_BUSY, type GitActionKind } from '../lib/gitActions'
import { baseSummary, plural } from '../lib/gitStatus'
import { RUN_STATE_INFO, type RunState } from '../lib/run'
import { SESSION_STATE_INFO, type SessionState } from '../lib/sessionState'
import { shortcutLabel } from '../lib/shortcuts'
import { DevUrlLinks } from './DevUrlLinks'
import { PopupMenu, type MenuItem } from './PopupMenu'
import { ICON } from '../lib/icon'
import { UsageBadge } from './UsageBadge'

/** The header's git line: checked-out branch, standing against the base, uncommitted files and the last commit. */
function GitLine({ git, baseRef }: { git: TaskGitStatus; baseRef: string }): React.JSX.Element {
  const standing = baseSummary(git, baseRef)
  return (
    <div className="task-git" aria-label="Git status">
      <span className="task-git-branch" title={`Checked-out branch: ${git.branch}`}>
        <GitBranch {...ICON} size={12} /> {git.branch}
      </span>
      <span
        className={`task-git-base${git.baseMissing ? ' warn' : ''}`}
        title={
          git.baseMissing
            ? `${baseRef} could not be found (deleted or not fetched), so commits ahead/behind are unknown`
            : standing
        }
      >
        {git.baseMissing ? (
          <>⚠ {standing}</>
        ) : (
          <>
            <span className={git.ahead > 0 ? 'git-ahead' : undefined}>↑{git.ahead}</span>{' '}
            <span className={git.behind > 0 ? 'git-behind' : undefined}>↓{git.behind}</span>
            <span className="task-git-vs"> vs {baseRef}</span>
          </>
        )}
      </span>
      {git.uncommitted > 0 && (
        <span className="git-dirty" title={plural(git.uncommitted, 'uncommitted file')}>
          ●{git.uncommitted} uncommitted
        </span>
      )}
      {git.lastCommit && (
        <span
          className="task-git-commit"
          title={`Last commit ${git.lastCommit.sha}, ${git.lastCommit.relativeDate}: ${git.lastCommit.subject}`}
        >
          <code>{git.lastCommit.sha}</code> {git.lastCommit.subject}
          <span className="task-git-when"> · {git.lastCommit.relativeDate}</span>
        </span>
      )}
    </div>
  )
}

export interface GitActionsProps {
  /** The task's branch and base, and how it is updated from the base, for the tooltips. */
  branch: string
  baseRef: string
  updateStrategy: UpdateStrategy
  /** The action running on this task; the buttons are off meanwhile. */
  busy?: GitActionKind
  /** Whether the GitHub CLI is installed; without it "PR" explains how to get it. */
  ghAvailable: boolean
  onCommit: () => void
  onPush: () => void
  onOpenPr: () => void
  onUpdate: () => void
}

/** Commit all, push, open a pull request and update from the base, as one button group. */
function GitActions(props: GitActionsProps): React.JSX.Element {
  const label = (kind: GitActionKind, idle: string): string => (props.busy === kind ? GIT_ACTION_BUSY[kind] : idle)
  const busy = props.busy !== undefined
  return (
    <div className="copy-group git-actions" role="group" aria-label="Git" aria-busy={busy}>
      <span className="copy-group-label" aria-hidden="true">
        Git
      </span>
      <button
        aria-label="Commit all…"
        title="Commit all changes in the worktree (git add -A, then git commit)"
        disabled={busy}
        onClick={props.onCommit}
      >
        <GitCommitHorizontal {...ICON} /> {label('commit', 'Commit…')}
      </button>
      <button
        aria-label="Push branch"
        title={`Push ${props.branch} to origin and track it (git push -u)`}
        disabled={busy}
        onClick={props.onPush}
      >
        <ArrowUp {...ICON} /> {label('push', 'Push')}
      </button>
      <button
        aria-label="Open pull request"
        className={props.ghAvailable ? undefined : 'unavailable'}
        aria-disabled={!props.ghAvailable || undefined}
        title={
          props.ghAvailable
            ? `Open the pull request for ${props.branch}, creating it from its commits if needed (gh pr create --fill)`
            : GH_INSTALL_HINT
        }
        disabled={busy}
        onClick={props.onOpenPr}
      >
        <GitPullRequest {...ICON} /> {label('pr', 'PR')}
      </button>
      <button
        aria-label="Update from base"
        title={
          props.updateStrategy === 'merge'
            ? `Fetch, then merge ${props.baseRef} into ${props.branch} (git merge --no-edit)`
            : `Fetch, then rebase ${props.branch} onto ${props.baseRef} (git rebase)`
        }
        disabled={busy}
        onClick={props.onUpdate}
      >
        <RefreshCw {...ICON} /> {label('update', 'Update')}
      </button>
    </div>
  )
}

export interface RunControlsProps {
  /** The repo's or folder's run command; undefined when none is set, and the group offers to set one. */
  command?: string
  /** The session's run tab (see runState). */
  state: RunState
  /** Shows the run tab, or opens one running the command. */
  onRun: () => void
  onRestart: () => void
  onStop: () => void
  /** Opens the run command dialog. */
  onEdit: () => void
}

/** Run, Restart and Stop the run command, with whether it runs; or, without a command, a way to set one. */
function RunControls(props: RunControlsProps): React.JSX.Element {
  const { command, state } = props
  return (
    <div className="copy-group run-group" role="group" aria-label="Run">
      <span className="copy-group-label" aria-hidden="true">
        Run
      </span>
      {command === undefined ? (
        <button
          aria-label="Set run command…"
          title="Set a command (e.g. npm run dev) to run in a “run” tab"
          onClick={props.onEdit}
        >
          <Play {...ICON} /> Set command…
        </button>
      ) : (
        <>
          {state !== 'none' && (
            <span
              className={`run-state ${state}`}
              title={RUN_STATE_INFO[state].title}
              aria-label={`Run: ${RUN_STATE_INFO[state].label}`}
            >
              <span aria-hidden="true">{RUN_STATE_INFO[state].glyph}</span> {RUN_STATE_INFO[state].label}
            </span>
          )}
          {/* The group's label already says Run: the button says what a click does now. */}
          {state === 'none' ? (
            <button aria-label={`Start ${command}`} title={`Run “${command}” in a “run” tab`} onClick={props.onRun}>
              <Play {...ICON} /> Start
            </button>
          ) : (
            <button aria-label="Show run tab" title="Show the “run” tab" onClick={props.onRun}>
              <SquareTerminal {...ICON} /> Show
            </button>
          )}
          {state !== 'none' && (
            <button aria-label="Restart run" title={`Stop and run “${command}” again`} onClick={props.onRestart}>
              <RotateCcw {...ICON} /> Restart
            </button>
          )}
          {state === 'running' && (
            <button aria-label="Stop run" title="Stop it (Ctrl-C); its output stays in the tab" onClick={props.onStop}>
              <Square {...ICON} /> Stop
            </button>
          )}
          <button aria-label="Edit run command…" title={`Edit the run command: ${command}`} onClick={props.onEdit}>
            <Pencil {...ICON} />
          </button>
        </>
      )}
    </div>
  )
}

/** "⋯": the header's less frequent actions (file manager, copies, notes, budget) in a menu. */
function MoreActions({ items }: { items: MenuItem[] }): React.JSX.Element {
  const [at, setAt] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null)
  const close = useCallback(() => setAt(null), [])
  return (
    <>
      <button
        className="header-btn header-more"
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(e) => {
          if (at) return setAt(null)
          const rect = e.currentTarget.getBoundingClientRect()
          setAt({ x: rect.right - 220, y: rect.bottom + 4, trigger: e.currentTarget })
        }}
      >
        <Ellipsis {...ICON} size={16} />
      </button>
      {at && (
        <PopupMenu
          label="More actions"
          className="tab-menu header-menu"
          x={at.x}
          y={at.y}
          trigger={at.trigger}
          items={items}
          onClose={close}
          triggerToggles
        />
      )}
    </>
  )
}

/**
 * The selected task's or folder's header: title, path line, and the task's notes, collapsed to one line until
 * clicked. Notes are plain text (a React text node), never HTML.
 */
export function TaskHeader(props: {
  title: string
  subtitle: string
  notes?: string
  /** Set for tasks: shows the "Edit notes" button. */
  onEditNotes?: () => void
  /** Set for tasks: "Set budget…" in the More actions menu, which opens the task's budget dialog. */
  onEditBudget?: () => void
  /** Set for tasks while there are accounts to choose from: "Claude account…" in the More actions menu. */
  onChooseProfile?: () => void
  /** Copy buttons (branch, path, attach command). */
  copies: CopyEntry[]
  onCopy: (entry: CopyEntry) => void
  /** Opens the task's worktree or the folder in an editor / the file manager. */
  onOpenInEditor: () => void
  onRevealInFileManager: () => void
  /** What new Claude sessions really start with (effectiveSessionFlags); shown as badges so it is never forgotten. */
  sessionFlags?: { remoteControl: boolean; skipPermissions: boolean }
  /** The target's Claude usage, once loaded: shown as a badge that opens the usage view. */
  usage?: UsageSummary
  /** The task's budget against its all-time cost (see UsageBadge); null or absent when it has none. */
  budget?: BudgetStatus | null
  onOpenUsage?: () => void
  /** A task's git status, once loaded, and the base ref it is compared with. */
  git?: TaskGitStatus
  baseRef?: string
  /** The session's state: whether Claude is working, waiting for the user or idle. */
  session?: SessionState
  /** Set for tasks: the Git button group. */
  gitActions?: GitActionsProps
  /** The run command's buttons (tasks and folders). */
  run?: RunControlsProps
  /** Dev-server URLs printed in the session's tabs (see getDevUrls), as links opened with onOpenUrl. */
  devUrls?: readonly DevUrl[]
  onOpenUrl?: (url: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <header className="task-header">
      <div className="task-header-top">
        <div className="task-header-text">
          <div className="task-title">
            {/* Cut to one line with an ellipsis (as is the path line), so the tooltip has it all. */}
            <span className="task-title-text" title={props.title}>
              {props.title}
            </span>
            {props.session && (
              <span
                className={`session-state ${props.session}`}
                title={SESSION_STATE_INFO[props.session].title}
                aria-label={`Session: ${SESSION_STATE_INFO[props.session].label}`}
              >
                <span className="session-state-dot" aria-hidden="true">
                  {SESSION_STATE_INFO[props.session].glyph}
                </span>
                {SESSION_STATE_INFO[props.session].label}
              </span>
            )}
            {props.sessionFlags?.remoteControl && (
              <span
                className="session-badge"
                title="New Claude sessions start with Remote Control on (--remote-control)"
              >
                Remote
              </span>
            )}
            {props.sessionFlags?.skipPermissions && (
              <span
                className="session-badge session-badge-warn"
                title="New Claude sessions skip permission prompts (--dangerously-skip-permissions): Claude runs commands without asking"
              >
                ⚠ permissions skipped
              </span>
            )}
          </div>
          <div className="task-subtitle" title={props.subtitle}>
            {props.subtitle}
          </div>
          {props.git && props.baseRef !== undefined && <GitLine git={props.git} baseRef={props.baseRef} />}
          {props.devUrls && props.devUrls.length > 0 && props.onOpenUrl && (
            <div className="task-urls" role="group" aria-label="Dev-server links">
              <span className="task-urls-label" aria-hidden="true">
                ↗
              </span>
              <DevUrlLinks urls={props.devUrls} onOpen={props.onOpenUrl} className="dev-url" />
            </div>
          )}
        </div>
        <div className="task-header-actions">
          <div className="task-header-actions-row">
            {props.usage && props.onOpenUsage && (
              <UsageBadge usage={props.usage} budget={props.budget} onOpen={props.onOpenUsage} />
            )}
            <button
              className="header-btn"
              aria-label="Open in editor"
              title={`Open in editor (${shortcutLabel('openEditor')})`}
              onClick={props.onOpenInEditor}
            >
              <Code {...ICON} /> Editor
            </button>
            <MoreActions
              items={[
                {
                  label: 'Reveal in file manager',
                  icon: <FolderOpen {...ICON} />,
                  run: props.onRevealInFileManager,
                },
                ...props.copies.map((entry) => ({
                  label: entry.label,
                  icon: <Copy {...ICON} />,
                  run: () => props.onCopy(entry),
                })),
                ...(props.onEditNotes
                  ? [{ label: 'Edit notes', icon: <StickyNote {...ICON} />, run: props.onEditNotes }]
                  : []),
                ...(props.onEditBudget
                  ? [{ label: 'Set budget…', icon: <CircleDollarSign {...ICON} />, run: props.onEditBudget }]
                  : []),
                ...(props.onChooseProfile
                  ? [{ label: 'Claude account…', icon: <UserRound {...ICON} />, run: props.onChooseProfile }]
                  : []),
              ]}
            />
          </div>
          {(props.run || props.gitActions) && (
            <div className="task-header-actions-row">
              {props.run && <RunControls {...props.run} />}
              {props.gitActions && <GitActions {...props.gitActions} />}
            </div>
          )}
        </div>
      </div>
      {props.notes && (
        <button
          className="task-notes"
          aria-expanded={expanded}
          title={expanded ? 'Collapse notes' : 'Show all notes'}
          onClick={() => setExpanded((e) => !e)}
        >
          {props.notes}
        </button>
      )}
    </header>
  )
}
