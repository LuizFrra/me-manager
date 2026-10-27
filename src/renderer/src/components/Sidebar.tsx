import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  ChartColumn,
  Folder,
  FolderDown,
  FolderGit2,
  FolderPlus,
  Palette,
  PanelLeft,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Settings2,
  X,
} from 'lucide-react'
import { budgetSummary } from '../../../shared/budget'
import {
  isArchived,
  type AppState,
  type BudgetStatus,
  type Item,
  type LiveStatus,
  type Target,
  type Task,
  type TaskGitStatus,
} from '../../../shared/types'
import type { BulkAction } from '../lib/bulk'
import { gitBadges, plural } from '../lib/gitStatus'
import { SESSION_STATE_INFO, sessionState } from '../lib/sessionState'
import { filterSidebar } from '../lib/sidebarFilter'
import { clickSelectMode, rowExtendStep, rowMoveStep, shortcutLabel } from '../lib/shortcuts'
import { neighbourTask, rangeOf, selectedTasks, taskRows, toggleTask } from '../lib/taskSelection'
import {
  dropIndex,
  entryId,
  entryParent,
  siblingIds,
  stepMove,
  type DropSide,
  type Move,
  type MoveEntry,
} from '../lib/reorder'
import { themeColorCss } from '../../../shared/themeStyle'
import { ICON } from '../lib/icon'
import { Chevron, Spark } from './icons'

export interface SidebarProps {
  state: AppState
  status: LiveStatus
  /** Git status of the visible tasks, by task id; a task without one shows no badges. */
  gitStatus?: Readonly<Record<string, TaskGitStatus>>
  /** Where each task's budget stands, by task id (BudgetReport.tasks): a task over its budget gets a small badge. */
  budgets?: Readonly<Record<string, BudgetStatus>>
  selected: Target | null
  /** Ids of collapsed themes and repos. App owns this, since Alt+1..9 (Cmd+1..9 on macOS) counts only visible entries. */
  collapsed: ReadonlySet<string>
  onToggleCollapsed: (id: string) => void
  /** The filter box's text; App owns it too, for the same reason. */
  filter: string
  onFilterChange: (filter: string) => void
  filterRef?: React.Ref<HTMLInputElement>
  /** A dialog or overlay is open: the sidebar can't be focused or clicked (see App). */
  inert?: boolean
  onSelect: (target: Target) => void
  onAddTheme: () => void
  /** New task: the home screen's composer. Without it, no New task button. */
  onNewTask?: () => void
  /** Collapsed to a rail of icons (toggle, New task, Usage, Settings), as Claude's sidebar collapses. */
  rail?: boolean
  /** Hides or shows the sidebar. Without it, no toggle. */
  onToggleSidebar?: () => void
  /** Targets (by targetKey) whose Claude finished while they weren't shown: marked until opened. */
  unread?: ReadonlySet<string>
  onRenameTheme: (themeId: string, currentName: string) => void
  /** Opens "Customize theme…" (colour and icon). */
  onCustomizeTheme: (themeId: string) => void
  onRemoveTheme: (themeId: string) => void
  onAddRepo: (themeId: string) => void
  onCloneRepo: (themeId: string) => void
  onAddFolder: (themeId: string) => void
  onRemoveItem: (themeId: string, itemId: string) => void
  /** Opens the repo's or folder's run command dialog. */
  onEditRunCommand: (themeId: string, itemId: string) => void
  onAddTask: (themeId: string, repoId: string) => void
  onRenameTask: (themeId: string, repoId: string, taskId: string, currentName: string) => void
  onRemoveTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
  onArchiveTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
  /** Ids of repos whose "Archived" group is expanded; each starts collapsed. App owns it, to remember it. */
  archivedOpen?: ReadonlySet<string>
  onToggleArchived: (repoId: string) => void
  onRestoreTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
  /** Deletes an archived task and its branch (App confirms first). */
  onDeleteArchivedTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
  /**
   * Moves a theme, repo, folder or active task to a new index among its siblings: dragged there, or one step with
   * Alt+Shift+↑/↓ on its row. Never into another theme or repo. Off while filtering, when only some rows show.
   */
  onMove: (move: Move) => void
  /**
   * Ids of the tasks in the multi-selection (see lib/taskSelection): Mod+click, Shift+click, Space and Shift+↑/↓
   * on task rows. App owns it, for the bulk actions and the palette.
   */
  multiSelection: ReadonlySet<string>
  onMultiSelect: (ids: ReadonlySet<string>) => void
  /** A bulk action on the selected tasks, from the bar that shows while two or more are (App confirms it first). */
  onBulkAction: (action: BulkAction) => void
  /** What the bulk action under way is doing ("Pushing 3 tasks…"): the bar says it, with its buttons off. */
  bulkBusy?: string
  /** Something for screen readers to hear (App's live region). */
  onAnnounce: (message: string) => void
  onOpenSettings: () => void
  onOpenUsage: () => void
}

/** The type of the sidebar's own drags, so a drop of anything else (a file) is never taken for a move. */
const DRAG_TYPE = 'application/x-me-manager-row'

/** A row's or block's props, with its `data-*` attributes. */
type DivProps = React.HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string }

/** A row label's place in the keyboard navigation: in the Tab order or not, its key and its depth in the tree. */
interface RowNavProps {
  tabIndex: 0 | -1
  'data-key': string
  'data-level': number
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

/** The theme row's colour stripe, as a CSS variable; none for no colour or one not in the palette. */
/** A small "$" after the name of a task over its budget, explained by its tooltip; nothing otherwise. */
function OverBudget({ status }: { status?: BudgetStatus }): React.JSX.Element | null {
  if (status?.level !== 'over') return null
  const text = `Over budget: ${budgetSummary(status, 'task budget')}`
  return (
    <span className="budget-badge" role="img" aria-label={text} title={text}>
      $
    </span>
  )
}

function themeStripe(color: unknown): React.CSSProperties | undefined {
  const css = themeColorCss(color)
  return css ? ({ '--theme-color': css } as React.CSSProperties) : undefined
}

/**
 * A repo's archived tasks, under a "▶ Archived (N)" toggle; nothing when it has none. They have no session, so no
 * status dot or git badges: a click selects one (the main area offers Restore), and its row has Restore and Delete.
 */
function ArchivedTasks(props: {
  repoId: string
  tasks: Task[]
  open: boolean
  selectedTaskId?: string
  /** The row labels' props for keyboard navigation (see Sidebar's rowNav). */
  nav: (key: string, level: number) => RowNavProps
  onToggle: () => void
  onSelect: (taskId: string, e: React.MouseEvent) => void
  onRestore: (task: Task) => void
  onDelete: (task: Task) => void
}): React.JSX.Element | null {
  if (props.tasks.length === 0) return null
  return (
    <>
      <div className="row archived-group-row">
        <button
          className="row-label"
          aria-expanded={props.open}
          title="Tasks whose worktree was removed; their branches are kept"
          onClick={props.onToggle}
          {...props.nav(`archived:${props.repoId}`, 3)}
        >
          <Chevron open={props.open} /> <span className="row-name">Archived ({props.tasks.length})</span>
        </button>
      </div>
      {props.open &&
        props.tasks.map((task) => (
          <div key={task.id} className={`row archived-row${props.selectedTaskId === task.id ? ' selected' : ''}`}>
            <button
              className="row-label"
              title={task.notes}
              onClick={(e) => props.onSelect(task.id, e)}
              {...props.nav(`task:${task.id}`, 4)}
            >
              <span className="row-name">{task.name}</span>
            </button>
            <span className="row-actions">
              <button
                aria-label={`Restore task ${task.name}`}
                title="Restore (recreate the worktree from the branch)"
                onClick={() => props.onRestore(task)}
              >
                <RotateCcw {...ICON} />
              </button>
              <button
                aria-label={`Delete archived task ${task.name}`}
                title="Delete the task and its branch…"
                onClick={() => props.onDelete(task)}
              >
                <X {...ICON} />
              </button>
            </span>
          </div>
        ))}
    </>
  )
}

/** A target whose Claude finished while it wasn't shown, as an unread chat is marked. */
function UnreadMark(): React.JSX.Element {
  return (
    <span className="unread-mark" title="Claude finished here since you last looked">
      <span className="sr-only">, new</span>
    </span>
  )
}

/** A repo's or folder's row button that edits its run command; the tooltip shows the command. */
function RunCommandButton({ item, onClick }: { item: Item; onClick: () => void }): React.JSX.Element {
  return (
    <button
      aria-label={`Run command for ${item.name}…`}
      title={item.runCommand ? `Edit the run command: ${item.runCommand}` : 'Set a run command…'}
      onClick={onClick}
    >
      {/* Not a play arrow: it edits the command rather than running it. */}
      <Settings2 {...ICON} />
    </button>
  )
}

export function Sidebar({ filterRef, ...p }: SidebarProps): React.JSX.Element {
  const { collapsed } = p
  const filter = filterSidebar(p.state, p.filter) // cheap: one pass over the names
  // While filtering, every group is expanded and only matches (and their ancestors) show. Collapsing is off
  // then, so a click can't silently collapse a group that reappears collapsed once the filter is cleared.
  const toggle = (id: string): void => {
    if (!filter) p.onToggleCollapsed(id)
  }
  const expanded = (id: string): boolean => filter !== null || !collapsed.has(id)
  const shown = (set: keyof NonNullable<typeof filter>, id: string): boolean => !filter || filter[set].has(id)
  const missing = new Set(p.status.missing)
  const arrow = (id: string): React.JSX.Element => <Chevron open={expanded(id)} />
  // ○ no session, ⚠ path missing, ● running: pulsing accent while Claude works, amber while it waits for the
  // user, green when idle (or when the claude window is gone).
  const dot = (id: string): React.JSX.Element => {
    const state = sessionState(p.status, id)
    const info = SESSION_STATE_INFO[state]
    const cls = state === 'none' || state === 'missing' || state === 'running' ? state : `running ${state}`
    return (
      <span className={`dot ${cls}`} title={info.title}>
        {info.glyph}
      </span>
    )
  }
  const isSelected = (itemId: string, taskId?: string): boolean =>
    p.selected?.itemId === itemId && p.selected?.taskId === taskId
  // A repo's "Archived" group: collapsed unless opened, and open (like every group) while filtering.
  const archivedExpanded = (repoId: string): boolean => filter !== null || (p.archivedOpen?.has(repoId) ?? false)

  // Reordering (see onMove), only without a filter: a move would go past rows it hides.
  const reorderable = filter === null
  const [dragged, setDragged] = useState<MoveEntry | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; side: DropSide } | null>(null)
  const navRef = useRef<HTMLElement>(null)
  // The row last moved with the keyboard. Moving a focused element in the DOM drops its focus, so once the row
  // shows at its new place it gets it back, unless the focus went somewhere else meanwhile.
  const refocus = useRef<string | null>(null)
  /** Focuses the label of the row of `id` (a theme, item or task id). */
  const focusRow = (id: string): void => {
    const rows = navRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []
    const row = [...rows].find((r) => r.dataset.row === id)
    row?.querySelector<HTMLElement>('.row-label')?.focus()
  }
  useEffect(() => {
    const id = refocus.current
    refocus.current = null
    if (id === null || (document.activeElement !== null && document.activeElement !== document.body)) return
    focusRow(id)
  }, [p.state])

  // Keyboard navigation, as in a tree: one row label is in the Tab order, and the arrows move between them (see
  // navigate). That one is the label focused last, unless the selection changed since; then the selected row's, or
  // the first row's when that one isn't shown.
  const selectedKey = p.selected
    ? p.selected.taskId
      ? `task:${p.selected.taskId}`
      : `item:${p.selected.itemId}`
    : null
  const [lastFocused, setLastFocused] = useState<{ key: string; selectedKey: string | null } | null>(null)
  const shownKeys = new Set<string>()
  for (const theme of p.state.themes) {
    if (!shown('themes', theme.id)) continue
    shownKeys.add(`theme:${theme.id}`)
    if (!expanded(theme.id)) continue
    for (const item of theme.items) {
      if (!shown('items', item.id)) continue
      shownKeys.add(`item:${item.id}`)
      if (item.kind !== 'repo' || !expanded(item.id)) continue
      for (const task of item.tasks) {
        if (!shown('tasks', task.id)) continue
        if (isArchived(task)) shownKeys.add(`archived:${item.id}`)
        if (!isArchived(task) || archivedExpanded(item.id)) shownKeys.add(`task:${task.id}`)
      }
    }
  }
  const tabStop =
    [lastFocused?.selectedKey === selectedKey ? lastFocused.key : null, selectedKey].find(
      (key) => key !== null && shownKeys.has(key),
    ) ?? shownKeys.values().next().value
  const rowNav = (key: string, level: number): RowNavProps => ({
    tabIndex: key === tabStop ? 0 : -1,
    'data-key': key,
    'data-level': level,
  })
  /**
   * The tree's keys on a focused row label: ↑ and ↓ go to the row above or below, Home and End to the first and last;
   * → expands a theme, repo or Archived group, or goes to its first row; ← collapses it, or goes to the row it is in.
   * ↓ in the filter goes to the first row, ↑ on the first row back to the filter. Enter opens, as a click does.
   */
  const navigate = (e: React.KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const labels = [...(navRef.current?.querySelectorAll<HTMLElement>('.row-label[data-key]') ?? [])]
    const filterBox = navRef.current?.querySelector<HTMLElement>('.sidebar-filter')
    if (e.target === filterBox && e.key === 'ArrowDown' && labels.length > 0) {
      e.preventDefault()
      return labels[0].focus()
    }
    const at = labels.indexOf(e.target as HTMLElement)
    if (at === -1) return
    const label = labels[at]
    const level = (el: HTMLElement): number => Number(el.dataset.level)
    const open = label.getAttribute('aria-expanded')
    let next: HTMLElement | null | undefined
    if (e.key === 'ArrowDown') next = labels[at + 1]
    else if (e.key === 'ArrowUp') next = at === 0 ? filterBox : labels[at - 1]
    else if (e.key === 'Home') next = labels[0]
    else if (e.key === 'End') next = labels.at(-1)
    else if (e.key === 'ArrowRight') {
      if (open === 'false') label.click()
      else if (open === 'true' && labels[at + 1] && level(labels[at + 1]) > level(label)) next = labels[at + 1]
    } else if (e.key === 'ArrowLeft') {
      // While filtering every group stays open: ← goes up instead.
      if (open === 'true' && !filter) label.click()
      else next = labels.slice(0, at).findLast((l) => level(l) < level(label))
    } else return
    e.preventDefault()
    next?.focus()
  }

  // The multi-selection. `anchor` is where a Shift range starts: the task last clicked or toggled here, else the
  // current task.
  const rows = taskRows(p.state, collapsed, filter)
  const anchor = useRef<string | undefined>(undefined)
  const currentTask = rows.some((r) => r.taskId === p.selected?.taskId) ? p.selected?.taskId : undefined
  const multi = selectedTasks(p.state, p.multiSelection)
  const choose = (next: ReadonlySet<string>): void => {
    p.onMultiSelect(next)
    p.onAnnounce(next.size === 0 ? 'Selection cleared' : `${plural(next.size, 'task')} selected`)
  }
  /** A plain click opens the task (and clears the multi-selection); Mod and Shift select instead (clickSelectMode). */
  const clickTask = (e: React.MouseEvent, target: Target & { taskId: string }): void => {
    const mode = clickSelectMode(e)
    const id = target.taskId
    if (mode === null) {
      anchor.current = id
      if (p.multiSelection.size > 0) choose(new Set())
      return p.onSelect(target)
    }
    if (mode === 'toggle') {
      anchor.current = id
      return choose(toggleTask(p.multiSelection, id, currentTask))
    }
    const from = anchor.current ?? currentTask ?? id
    anchor.current = from
    const range = rangeOf(rows, from, id)
    choose(new Set(mode === 'addRange' ? [...p.multiSelection, ...range] : range))
  }
  /** Folders and archived tasks open on any click; Mod and Shift, which select tasks, do nothing there. */
  const clickOther = (e: React.MouseEvent, target: Target, refusal: string): void => {
    if (clickSelectMode(e) !== null) return p.onAnnounce(refusal)
    if (p.multiSelection.size > 0) choose(new Set())
    p.onSelect(target)
  }
  /**
   * A task row's keys: Alt+Shift+↑/↓ moves it; Space on its label toggles it into the selection; Shift+↑/↓ extends
   * the selection to the task above or below in its repo, from the anchor (or this task, if the anchor is in another
   * repo), and moves the focus there.
   */
  const taskKeys = (e: React.KeyboardEvent, entry: Extract<MoveEntry, { kind: 'task' }>): void => {
    if (rowMoveStep(e) !== 0) return moveByKey(e, entry)
    const id = entry.taskId
    const onLabel = e.target instanceof HTMLElement && e.target.classList.contains('row-label')
    if (e.key === ' ' && onLabel && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault() // no click: that would open the task
      anchor.current = id
      return choose(toggleTask(p.multiSelection, id, currentTask))
    }
    const step = rowExtendStep(e)
    if (step === 0) return
    e.preventDefault()
    const next = neighbourTask(rows, id, step)
    if (next === undefined) return
    const from = rows.find((r) => r.taskId === anchor.current)?.repoId === entry.repoId ? anchor.current : id
    anchor.current = from
    choose(new Set(rangeOf(rows, from, next)))
    focusRow(next)
  }

  const endDrag = (): void => {
    setDragged(null)
    setDropAt(null)
  }
  const startDrag = (e: React.DragEvent, entry: MoveEntry): void => {
    // Mod and Shift select tasks: a click with them that wanders a little never turns into a drag.
    if (!reorderable || clickSelectMode(e) !== null) return e.preventDefault()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE, entryId(entry))
    setDragged(entry)
  }
  /**
   * The row the dragged entry is over, if it may be dropped there, and which half of it: a sibling's (a task's in
   * its repo, an item's in its theme, a theme's) along with what is under that row (a theme's items, a repo's
   * tasks). Null anywhere else, which refuses the drop.
   */
  const dropTarget = (e: React.DragEvent): { id: string; side: DropSide } | null => {
    if (!dragged || !(e.target instanceof Element)) return null
    const zone = e.target.closest<HTMLElement>(`[data-drop="${dragged.kind}"]`)
    if (!zone?.dataset.id || zone.dataset.parent !== entryParent(dragged)) return null
    const rect = zone.getBoundingClientRect()
    return { id: zone.dataset.id, side: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' }
  }
  /** Where the dragged entry ends up if dropped on `target`; null where it stays put. */
  const dropTo = (target: { id: string; side: DropSide } | null): number | null =>
    dragged && target && dropIndex(siblingIds(p.state, dragged), entryId(dragged), target.id, target.side)
  const dragOver = (e: React.DragEvent): void => {
    if (!dragged) return // not one of the sidebar's rows: no drop
    const target = dropTarget(e)
    // Refused: the default stays, which shows the not-allowed cursor.
    if (target) e.preventDefault()
    e.dataTransfer.dropEffect = target ? 'move' : 'none'
    // A line between rows where it would go; none where it would stay where it is.
    const line = dropTo(target) === null ? null : target
    setDropAt((prev) => (prev?.id === line?.id && prev?.side === line?.side ? prev : line))
  }
  const drop = (e: React.DragEvent): void => {
    if (!dragged) return
    e.preventDefault()
    const toIndex = dropTo(dropTarget(e))
    const entry = dragged
    endDrag()
    if (toIndex !== null) p.onMove({ ...entry, toIndex })
  }
  const moveByKey = (e: React.KeyboardEvent, entry: MoveEntry): void => {
    const step = rowMoveStep(e)
    if (step === 0) return
    e.preventDefault()
    if (!reorderable) return p.onAnnounce('Clear the filter to move rows')
    const move = stepMove(p.state, entry, step)
    if (!move) return
    refocus.current = entryId(entry)
    p.onMove(move)
  }
  /** A row that can be dragged, and moved with Alt+Shift+↑/↓ while one of its buttons has the focus. */
  const movable = (entry: MoveEntry): DivProps => ({
    draggable: reorderable,
    'data-row': entryId(entry),
    onDragStart: (e) => startDrag(e, entry),
    onKeyDown: (e) => moveByKey(e, entry),
  })
  /** What a dragged sibling of `entry` drops on (see dropTarget), with its indicator line and dragged look. */
  const dropZone = (entry: MoveEntry, className: string): DivProps => {
    const id = entryId(entry)
    const isDragged = dragged !== null && entryId(dragged) === id
    const line = dropAt?.id === id ? ` drop-${dropAt.side}` : ''
    return {
      className: `${className}${isDragged ? ' dragging' : ''}${line}`,
      'data-drop': entry.kind,
      'data-id': id,
      'data-parent': entryParent(entry),
    }
  }

  if (p.rail)
    return (
      <nav className="sidebar sidebar-rail" aria-label="Sidebar" inert={p.inert}>
        {p.onToggleSidebar && (
          <button
            aria-label="Show sidebar"
            title={`Show sidebar (${shortcutLabel('sidebar')})`}
            onClick={p.onToggleSidebar}
          >
            <PanelLeft {...ICON} size={18} />
          </button>
        )}
        {p.onNewTask && (
          <button
            className="sidebar-rail-new"
            aria-label="New task"
            title={`New task (${shortcutLabel('newTask')})`}
            onClick={p.onNewTask}
          >
            <Plus {...ICON} size={16} strokeWidth={2.25} />
          </button>
        )}
        <span className="sidebar-rail-spacer" />
        <button
          aria-label="Usage"
          title={`Claude usage and estimated cost (${shortcutLabel('usage')})`}
          onClick={p.onOpenUsage}
        >
          <ChartColumn {...ICON} size={18} />
        </button>
        <button aria-label="Settings" title={`Settings (${shortcutLabel('settings')})`} onClick={p.onOpenSettings}>
          <Settings {...ICON} size={18} />
        </button>
      </nav>
    )

  return (
    <nav
      ref={navRef}
      className="sidebar"
      inert={p.inert}
      onKeyDown={(e) => {
        // Esc anywhere in the sidebar clears the selection; the filter's Esc clears the filter only.
        if (e.key !== 'Escape' || e.isDefaultPrevented() || p.multiSelection.size === 0) return
        e.preventDefault()
        choose(new Set())
      }}
    >
      <div className="sidebar-brand">
        <Spark />
        <span className="sidebar-brand-name">me-manager</span>
        {p.onToggleSidebar && (
          <button
            className="sidebar-toggle"
            aria-label="Hide sidebar"
            title={`Hide sidebar (${shortcutLabel('sidebar')})`}
            onClick={p.onToggleSidebar}
          >
            <PanelLeft {...ICON} size={18} />
          </button>
        )}
      </div>
      {p.onNewTask && (
        <button
          className="sidebar-new-task"
          title={`Start a new task from a prompt (${shortcutLabel('newTask')})`}
          onClick={p.onNewTask}
        >
          <span className="sidebar-new-task-icon">
            <Plus {...ICON} strokeWidth={2.25} />
          </span>
          New task
        </button>
      )}
      <div
        className="sidebar-scroll"
        onKeyDown={navigate}
        onFocus={(e) => {
          const key = e.target instanceof HTMLElement ? e.target.dataset.key : undefined
          if (key && (key !== lastFocused?.key || selectedKey !== lastFocused.selectedKey))
            setLastFocused({ key, selectedKey })
        }}
        onDragOver={dragOver}
        onDrop={drop}
        onDragEnd={endDrag}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDropAt(null)
        }}
      >
        <input
          ref={filterRef}
          className="sidebar-filter"
          aria-label="Filter sidebar"
          placeholder={`Filter (${shortcutLabel('filterSidebar')})`}
          spellCheck={false}
          value={p.filter}
          onChange={(e) => p.onFilterChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            p.onFilterChange('')
          }}
        />
        <div className="sidebar-header">
          <span>Themes</span>
          <button aria-label="New theme" title="New theme" onClick={p.onAddTheme}>
            <Plus {...ICON} />
          </button>
        </div>
        {p.state.themes.length === 0 && !filter && <p className="hint">Create a theme to get started.</p>}
        {filter && filter.themes.size === 0 && <p className="hint">No matches</p>}
        {p.state.themes
          .filter((theme) => shown('themes', theme.id))
          .map((theme) => (
            <div key={theme.id} {...dropZone({ kind: 'theme', themeId: theme.id }, 'theme')}>
              <div
                className={`row theme-row${themeColorCss(theme.color) ? ' has-color' : ''}`}
                style={themeStripe(theme.color)}
                {...movable({ kind: 'theme', themeId: theme.id })}
              >
                <button
                  className="row-label"
                  aria-expanded={expanded(theme.id)}
                  onClick={() => toggle(theme.id)}
                  {...rowNav(`theme:${theme.id}`, 1)}
                >
                  {arrow(theme.id)}{' '}
                  {theme.icon && (
                    <span className="theme-icon" aria-hidden="true">
                      {theme.icon}
                    </span>
                  )}
                  <span className="row-name">{theme.name}</span>
                </button>
                <span className="row-actions">
                  <button
                    aria-label={`Add repository to ${theme.name}`}
                    title="Add repository"
                    onClick={() => p.onAddRepo(theme.id)}
                  >
                    <FolderGit2 {...ICON} />
                  </button>
                  <button
                    aria-label={`Clone repository into ${theme.name}`}
                    title="Clone repository…"
                    onClick={() => p.onCloneRepo(theme.id)}
                  >
                    <FolderDown {...ICON} />
                  </button>
                  <button
                    aria-label={`Add folder to ${theme.name}`}
                    title="Add folder"
                    onClick={() => p.onAddFolder(theme.id)}
                  >
                    <FolderPlus {...ICON} />
                  </button>
                  <button
                    aria-label={`Customize theme ${theme.name}`}
                    title="Customize theme…"
                    onClick={() => p.onCustomizeTheme(theme.id)}
                  >
                    <Palette {...ICON} />
                  </button>
                  <button
                    aria-label={`Rename theme ${theme.name}`}
                    title="Rename theme"
                    onClick={() => p.onRenameTheme(theme.id, theme.name)}
                  >
                    <Pencil {...ICON} />
                  </button>
                  <button
                    aria-label={`Remove theme ${theme.name}`}
                    title="Remove theme"
                    onClick={() => p.onRemoveTheme(theme.id)}
                  >
                    <X {...ICON} />
                  </button>
                </span>
              </div>
              {expanded(theme.id) &&
                theme.items
                  .filter((item) => shown('items', item.id))
                  .map((item) =>
                    item.kind === 'folder' ? (
                      <div
                        key={item.id}
                        {...dropZone(
                          { kind: 'item', themeId: theme.id, itemId: item.id },
                          `row item-row${isSelected(item.id) ? ' selected' : ''}`,
                        )}
                        {...movable({ kind: 'item', themeId: theme.id, itemId: item.id })}
                      >
                        <button
                          className="row-label"
                          onClick={(e) =>
                            clickOther(e, { themeId: theme.id, itemId: item.id }, 'Only tasks can be selected')
                          }
                          {...rowNav(`item:${item.id}`, 2)}
                        >
                          {dot(item.id)} <Folder {...ICON} className="item-icon" />{' '}
                          <span className="row-name">{item.name}</span>
                          {p.unread?.has(item.id) && <UnreadMark />}
                        </button>
                        <span className="row-actions">
                          <RunCommandButton item={item} onClick={() => p.onEditRunCommand(theme.id, item.id)} />
                          <button
                            aria-label={`Remove ${item.name}`}
                            title="Remove folder"
                            onClick={() => p.onRemoveItem(theme.id, item.id)}
                          >
                            <X {...ICON} />
                          </button>
                        </span>
                      </div>
                    ) : (
                      <div key={item.id} {...dropZone({ kind: 'item', themeId: theme.id, itemId: item.id }, 'repo')}>
                        <div
                          className="row item-row"
                          {...movable({ kind: 'item', themeId: theme.id, itemId: item.id })}
                        >
                          <button
                            className="row-label"
                            aria-expanded={expanded(item.id)}
                            onClick={() => toggle(item.id)}
                            {...rowNav(`item:${item.id}`, 2)}
                          >
                            {arrow(item.id)} {missing.has(item.id) ? '⚠ ' : ''}
                            <FolderGit2 {...ICON} className="item-icon" /> <span className="row-name">{item.name}</span>
                          </button>
                          <span className="row-actions">
                            <button
                              aria-label={`New task in ${item.name}`}
                              title="New task"
                              onClick={() => p.onAddTask(theme.id, item.id)}
                            >
                              <Plus {...ICON} />
                            </button>
                            <RunCommandButton item={item} onClick={() => p.onEditRunCommand(theme.id, item.id)} />
                            <button
                              aria-label={`Remove ${item.name}`}
                              title="Remove repository"
                              onClick={() => p.onRemoveItem(theme.id, item.id)}
                            >
                              <X {...ICON} />
                            </button>
                          </span>
                        </div>
                        {expanded(item.id) &&
                          item.tasks
                            .filter((task) => !isArchived(task) && shown('tasks', task.id))
                            .map((task) => (
                              <div
                                key={task.id}
                                {...dropZone(
                                  { kind: 'task', themeId: theme.id, repoId: item.id, taskId: task.id },
                                  `row task-row${isSelected(item.id, task.id) ? ' selected' : ''}${p.multiSelection.has(task.id) ? ' multi-selected' : ''}`,
                                )}
                                {...movable({ kind: 'task', themeId: theme.id, repoId: item.id, taskId: task.id })}
                                onKeyDown={(e) =>
                                  taskKeys(e, { kind: 'task', themeId: theme.id, repoId: item.id, taskId: task.id })
                                }
                                aria-selected={p.multiSelection.has(task.id)}
                              >
                                <button
                                  className="row-label"
                                  title={task.notes}
                                  onClick={(e) => clickTask(e, { themeId: theme.id, itemId: item.id, taskId: task.id })}
                                  {...rowNav(`task:${task.id}`, 3)}
                                >
                                  {dot(task.id)} <span className="row-name">{task.name}</span>
                                  {p.unread?.has(task.id) && <UnreadMark />}
                                </button>
                                <OverBudget status={p.budgets?.[task.id]} />
                                {p.gitStatus?.[task.id] && (
                                  <GitBadges status={p.gitStatus[task.id]} baseRef={task.baseRef} />
                                )}
                                <span className="row-actions">
                                  <button
                                    aria-label={`Rename task ${task.name}`}
                                    title="Rename task"
                                    onClick={() => p.onRenameTask(theme.id, item.id, task.id, task.name)}
                                  >
                                    <Pencil {...ICON} />
                                  </button>
                                  <button
                                    aria-label={`Archive task ${task.name}`}
                                    title="Archive task (removes the worktree, keeps the branch)"
                                    onClick={() => p.onArchiveTask(theme.id, item.id, task.id, task.name)}
                                  >
                                    <Archive {...ICON} />{' '}
                                  </button>
                                  <button
                                    aria-label={`Remove task ${task.name}`}
                                    title="Remove task"
                                    onClick={() => p.onRemoveTask(theme.id, item.id, task.id, task.name)}
                                  >
                                    <X {...ICON} />
                                  </button>
                                </span>
                              </div>
                            ))}
                        {expanded(item.id) && (
                          <ArchivedTasks
                            repoId={item.id}
                            nav={rowNav}
                            tasks={item.tasks.filter((task) => isArchived(task) && shown('tasks', task.id))}
                            open={archivedExpanded(item.id)}
                            selectedTaskId={p.selected?.itemId === item.id ? p.selected.taskId : undefined}
                            onToggle={() => {
                              if (!filter) p.onToggleArchived(item.id)
                            }}
                            onSelect={(taskId, e) =>
                              clickOther(
                                e,
                                { themeId: theme.id, itemId: item.id, taskId },
                                'Archived tasks can’t be selected',
                              )
                            }
                            onRestore={(task) => p.onRestoreTask(theme.id, item.id, task.id, task.name)}
                            onDelete={(task) => p.onDeleteArchivedTask(theme.id, item.id, task.id, task.name)}
                          />
                        )}
                      </div>
                    ),
                  )}
            </div>
          ))}
      </div>
      {/* Kept while a batch runs, as the tasks it archives or removes leave the selection. */}
      {(multi.length >= 2 || p.bulkBusy !== undefined) && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected tasks">
          <span className="bulk-bar-count">{p.bulkBusy ?? `${multi.length} tasks selected`}</span>
          <span className="bulk-bar-actions">
            <button
              aria-label="Push the selected tasks…"
              title="Push each selected task's branch"
              disabled={p.bulkBusy !== undefined}
              onClick={() => p.onBulkAction('push')}
            >
              Push…
            </button>
            <button
              aria-label="Update the selected tasks from base…"
              title="Fetch, then update each selected task from its base"
              disabled={p.bulkBusy !== undefined}
              onClick={() => p.onBulkAction('update')}
            >
              Update…
            </button>
            <button
              aria-label="Archive the selected tasks…"
              title="Archive the selected tasks (removes their worktrees, keeps their branches)"
              disabled={p.bulkBusy !== undefined}
              onClick={() => p.onBulkAction('archive')}
            >
              Archive…
            </button>
            <button
              aria-label="Remove the selected tasks…"
              title="Remove the selected tasks"
              className="bulk-bar-remove"
              disabled={p.bulkBusy !== undefined}
              onClick={() => p.onBulkAction('remove')}
            >
              Remove…
            </button>
            <button
              aria-label="Clear the selection"
              title="Clear the selection (Esc)"
              disabled={p.bulkBusy !== undefined}
              onClick={() => choose(new Set())}
            >
              Clear
            </button>
          </span>
        </div>
      )}
      <div className="sidebar-footer">
        <button
          className="sidebar-settings"
          aria-label="Usage"
          title={`Claude usage and estimated cost (${shortcutLabel('usage')})`}
          onClick={p.onOpenUsage}
        >
          <ChartColumn {...ICON} /> Usage
        </button>
        <button
          className="sidebar-settings"
          aria-label="Settings"
          title={`Settings (${shortcutLabel('settings')})`}
          onClick={p.onOpenSettings}
        >
          <Settings {...ICON} /> Settings
        </button>
      </div>
    </nav>
  )
}
