import { Archive, Pencil, X } from 'lucide-react'
import type { Task, TaskGitStatus } from '../../../shared/types'
import { gitBadges } from '../lib/gitStatus'
import { ICON } from '../lib/icon'
import type { DropSide, MoveEntry } from '../lib/reorder'
import { rowTitle } from '../lib/rowTitle'
import { SESSION_STATE_INFO, type SessionState } from '../lib/sessionState'

type TaskEntry = Extract<MoveEntry, { kind: 'task' }>

/**
 * ○ no session, ⚠ path missing, ● running: pulsing accent while Claude works, amber while it waits for the user,
 * green when idle (or when the claude window is gone).
 */
export function SessionDot({ state }: { state: SessionState }): React.JSX.Element {
  const info = SESSION_STATE_INFO[state]
  const cls = state === 'none' || state === 'missing' || state === 'running' ? state : `running ${state}`
  return (
    <span className={`dot ${cls}`} title={info.title}>
      {info.glyph}
    </span>
  )
}

/** The session state after the name, for screen readers: the dot's glyph is the same for several states. */
export function StateNote({ state }: { state: SessionState }): React.JSX.Element | null {
  if (state === 'none' || state === 'running') return null
  return <span className="sr-only">, {SESSION_STATE_INFO[state].label.toLowerCase()}</span>
}

/** A target whose Claude finished while it wasn't shown, as an unread chat is marked. */
export function UnreadMark(): React.JSX.Element {
  return (
    <span className="unread-mark" title="Claude finished here since you last looked">
      <span className="sr-only">, new</span>
    </span>
  )
}

/** ↑ ahead, ↓ behind, ● uncommitted; one accessible label for the group, a tooltip on each badge. */
function GitBadges({ status, baseRef }: { status: TaskGitStatus; baseRef: string }): React.JSX.Element | null {
  const badges = gitBadges(status, baseRef)
  if (badges.length === 0) return null
  return (
    <span className="git-badges" role="img" aria-label={badges.map((b) => b.title).join(', ')}>
      {badges.map((b) => (
        <span key={b.kind} className={`git-badge git-${b.kind}`} title={b.title} aria-hidden="true">
          {b.text}
        </span>
      ))}
    </span>
  )
}

/** A small "$" after the name of a task over its budget, explained by its tooltip (`overBudget`). */
function OverBudget({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="budget-badge" role="img" aria-label={text} title={text}>
      $
    </span>
  )
}

/**
 * An active task's row. Its props are only what it shows (no whole status or selection), so that, memoized by the
 * sidebar, a poll that changes one task's dot or badges renders that row alone.
 */
export function TaskRow(props: {
  themeId: string
  repoId: string
  task: Task
  state: SessionState
  selected: boolean
  multiSelected: boolean
  unread: boolean
  /** The row label is the tree's Tab stop (see Sidebar's rowNav). */
  tabbable: boolean
  git?: TaskGitStatus
  /** The over-budget badge's text; no badge without it. */
  overBudget?: string
  draggable: boolean
  dragging: boolean
  /** Where the indicator line of a drop on this row shows. */
  dropSide?: DropSide
  onClick: (e: React.MouseEvent, target: { themeId: string; itemId: string; taskId: string }) => void
  onKeyDown: (e: React.KeyboardEvent, entry: TaskEntry) => void
  onDragStart: (e: React.DragEvent, entry: TaskEntry) => void
  onRename: (themeId: string, repoId: string, taskId: string, currentName: string) => void
  onArchive: (themeId: string, repoId: string, taskId: string, taskName: string) => void
  onRemove: (themeId: string, repoId: string, taskId: string, taskName: string) => void
}): React.JSX.Element {
  const { themeId, repoId, task } = props
  const entry: TaskEntry = { kind: 'task', themeId, repoId, taskId: task.id }
  const className =
    'row task-row' +
    (props.selected ? ' selected' : '') +
    (props.multiSelected ? ' multi-selected' : '') +
    (props.dragging ? ' dragging' : '') +
    (props.dropSide ? ` drop-${props.dropSide}` : '')
  return (
    <div
      className={className}
      data-drop="task"
      data-id={task.id}
      data-parent={repoId}
      draggable={props.draggable}
      data-row={task.id}
      onDragStart={(e) => props.onDragStart(e, entry)}
      onKeyDown={(e) => props.onKeyDown(e, entry)}
    >
      <button
        className="row-label"
        title={rowTitle(task.name, task.notes)}
        aria-current={props.selected ? 'true' : undefined}
        onClick={(e) => props.onClick(e, { themeId, itemId: repoId, taskId: task.id })}
        tabIndex={props.tabbable ? 0 : -1}
        data-key={`task:${task.id}`}
        data-level={3}
      >
        <SessionDot state={props.state} /> <span className="row-name">{task.name}</span>
        <StateNote state={props.state} />
        {props.unread && <UnreadMark />}
        {/* In the multi-selection: said with the name, as the row is not a selectable role. */}
        {props.multiSelected && <span className="sr-only">, selected</span>}
      </button>
      {props.overBudget !== undefined && <OverBudget text={props.overBudget} />}
      {props.git && <GitBadges status={props.git} baseRef={task.baseRef} />}
      <span className="row-actions">
        <button
          aria-label={`Rename task ${task.name}`}
          title="Rename task"
          onClick={() => props.onRename(themeId, repoId, task.id, task.name)}
        >
          <Pencil {...ICON} />
        </button>
        <button
          aria-label={`Archive task ${task.name}`}
          title="Archive task (removes the worktree, keeps the branch)"
          onClick={() => props.onArchive(themeId, repoId, task.id, task.name)}
        >
          <Archive {...ICON} />{' '}
        </button>
        <button
          aria-label={`Remove task ${task.name}`}
          title="Remove task"
          onClick={() => props.onRemove(themeId, repoId, task.id, task.name)}
        >
          <X {...ICON} />
        </button>
      </span>
    </div>
  )
}
