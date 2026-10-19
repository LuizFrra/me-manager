import { useEffect, useRef, useState } from 'react'
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
import { gitBadges } from '../lib/gitStatus'
import { SESSION_STATE_INFO, sessionState } from '../lib/sessionState'
import { filterSidebar } from '../lib/sidebarFilter'
import { rowMoveStep, shortcutLabel } from '../lib/shortcuts'
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
  /** Something for screen readers to hear (App's live region). */
  onAnnounce: (message: string) => void
  onOpenSettings: () => void
  onOpenUsage: () => void
}

/** The type of the sidebar's own drags, so a drop of anything else (a file) is never taken for a move. */
const DRAG_TYPE = 'application/x-me-manager-row'

/** A row's or block's props, with its `data-*` attributes. */
type DivProps = React.HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string }

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
  tasks: Task[]
  open: boolean
  selectedTaskId?: string
  onToggle: () => void
  onSelect: (taskId: string) => void
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
        >
          {props.open ? '▼' : '▶'} Archived ({props.tasks.length})
        </button>
      </div>
      {props.open &&
        props.tasks.map((task) => (
          <div key={task.id} className={`row archived-row${props.selectedTaskId === task.id ? ' selected' : ''}`}>
            <button className="row-label" title={task.notes} onClick={() => props.onSelect(task.id)}>
              {task.name}
            </button>
            <span className="row-actions">
              <button
                aria-label={`Restore task ${task.name}`}
                title="Restore (recreate the worktree from the branch)"
                onClick={() => props.onRestore(task)}
              >
                ↺
              </button>
              <button
                aria-label={`Delete archived task ${task.name}`}
                title="Delete the task and its branch…"
                onClick={() => props.onDelete(task)}
              >
                ×
              </button>
            </span>
          </div>
        ))}
    </>
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
      {/* Not ▶: it edits the command rather than running it, and ▶ is the tree's expand arrow. */}⚙
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
  const arrow = (id: string): string => (expanded(id) ? '▼' : '▶')
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
  useEffect(() => {
    const id = refocus.current
    refocus.current = null
    if (id === null || (document.activeElement !== null && document.activeElement !== document.body)) return
    const rows = navRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []
    const row = [...rows].find((r) => r.dataset.row === id)
    row?.querySelector<HTMLElement>('.row-label')?.focus()
  }, [p.state])

  const endDrag = (): void => {
    setDragged(null)
    setDropAt(null)
  }
  const startDrag = (e: React.DragEvent, entry: MoveEntry): void => {
    if (!reorderable) return e.preventDefault()
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

  return (
    <nav ref={navRef} className="sidebar" inert={p.inert}>
      <div
        className="sidebar-scroll"
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
          <span>THEMES</span>
          <button aria-label="New theme" title="New theme" onClick={p.onAddTheme}>
            +
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
                <button className="row-label" onClick={() => toggle(theme.id)}>
                  {arrow(theme.id)}{' '}
                  {theme.icon && (
                    <span className="theme-icon" aria-hidden="true">
                      {theme.icon}
                    </span>
                  )}
                  {theme.name}
                </button>
                <span className="row-actions">
                  <button
                    aria-label={`Add repository to ${theme.name}`}
                    title="Add repository"
                    onClick={() => p.onAddRepo(theme.id)}
                  >
                    📦+
                  </button>
                  <button
                    aria-label={`Clone repository into ${theme.name}`}
                    title="Clone repository…"
                    onClick={() => p.onCloneRepo(theme.id)}
                  >
                    📦⤓
                  </button>
                  <button
                    aria-label={`Add folder to ${theme.name}`}
                    title="Add folder"
                    onClick={() => p.onAddFolder(theme.id)}
                  >
                    📁+
                  </button>
                  <button
                    aria-label={`Customize theme ${theme.name}`}
                    title="Customize theme…"
                    onClick={() => p.onCustomizeTheme(theme.id)}
                  >
                    🎨
                  </button>
                  <button
                    aria-label={`Rename theme ${theme.name}`}
                    title="Rename theme"
                    onClick={() => p.onRenameTheme(theme.id, theme.name)}
                  >
                    ✎
                  </button>
                  <button
                    aria-label={`Remove theme ${theme.name}`}
                    title="Remove theme"
                    onClick={() => p.onRemoveTheme(theme.id)}
                  >
                    ×
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
                          onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id })}
                        >
                          {dot(item.id)} 📁 {item.name}
                        </button>
                        <span className="row-actions">
                          <RunCommandButton item={item} onClick={() => p.onEditRunCommand(theme.id, item.id)} />
                          <button
                            aria-label={`Remove ${item.name}`}
                            title="Remove folder"
                            onClick={() => p.onRemoveItem(theme.id, item.id)}
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    ) : (
                      <div key={item.id} {...dropZone({ kind: 'item', themeId: theme.id, itemId: item.id }, 'repo')}>
                        <div
                          className="row item-row"
                          {...movable({ kind: 'item', themeId: theme.id, itemId: item.id })}
                        >
                          <button className="row-label" onClick={() => toggle(item.id)}>
                            {arrow(item.id)} {missing.has(item.id) ? '⚠ ' : ''}📦 {item.name}
                          </button>
                          <span className="row-actions">
                            <button
                              aria-label={`New task in ${item.name}`}
                              title="New task"
                              onClick={() => p.onAddTask(theme.id, item.id)}
                            >
                              +
                            </button>
                            <RunCommandButton item={item} onClick={() => p.onEditRunCommand(theme.id, item.id)} />
                            <button
                              aria-label={`Remove ${item.name}`}
                              title="Remove repository"
                              onClick={() => p.onRemoveItem(theme.id, item.id)}
                            >
                              ×
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
                                  `row task-row${isSelected(item.id, task.id) ? ' selected' : ''}`,
                                )}
                                {...movable({ kind: 'task', themeId: theme.id, repoId: item.id, taskId: task.id })}
                              >
                                <button
                                  className="row-label"
                                  title={task.notes}
                                  onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id, taskId: task.id })}
                                >
                                  {dot(task.id)} {task.name}
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
                                    ✎
                                  </button>
                                  <button
                                    aria-label={`Archive task ${task.name}`}
                                    title="Archive task (removes the worktree, keeps the branch)"
                                    onClick={() => p.onArchiveTask(theme.id, item.id, task.id, task.name)}
                                  >
                                    🗄
                                  </button>
                                  <button
                                    aria-label={`Remove task ${task.name}`}
                                    title="Remove task"
                                    onClick={() => p.onRemoveTask(theme.id, item.id, task.id, task.name)}
                                  >
                                    ×
                                  </button>
                                </span>
                              </div>
                            ))}
                        {expanded(item.id) && (
                          <ArchivedTasks
                            tasks={item.tasks.filter((task) => isArchived(task) && shown('tasks', task.id))}
                            open={archivedExpanded(item.id)}
                            selectedTaskId={p.selected?.itemId === item.id ? p.selected.taskId : undefined}
                            onToggle={() => {
                              if (!filter) p.onToggleArchived(item.id)
                            }}
                            onSelect={(taskId) => p.onSelect({ themeId: theme.id, itemId: item.id, taskId })}
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
      <div className="sidebar-footer">
        <button
          className="sidebar-settings"
          aria-label="Usage"
          title={`Claude usage and estimated cost (${shortcutLabel('usage')})`}
          onClick={p.onOpenUsage}
        >
          <span aria-hidden="true">$</span> Usage
        </button>
        <button
          className="sidebar-settings"
          aria-label="Settings"
          title={`Settings (${shortcutLabel('settings')})`}
          onClick={p.onOpenSettings}
        >
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </div>
    </nav>
  )
}
