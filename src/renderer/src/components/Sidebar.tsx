import {
  isArchived,
  type AppState,
  type Item,
  type LiveStatus,
  type Target,
  type Task,
  type TaskGitStatus,
} from '../../../shared/types'
import { gitBadges } from '../lib/gitStatus'
import { SESSION_STATE_INFO, sessionState } from '../lib/sessionState'
import { filterSidebar } from '../lib/sidebarFilter'
import { shortcutLabel } from '../lib/shortcuts'
import { themeColorCss } from '../../../shared/themeStyle'

export interface SidebarProps {
  state: AppState
  status: LiveStatus
  /** Git status of the visible tasks, by task id; a task without one shows no badges. */
  gitStatus?: Readonly<Record<string, TaskGitStatus>>
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
  onOpenSettings: () => void
  onOpenUsage: () => void
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

/** A repo's or folder's row button for its run command; the tooltip shows the command. */
function RunCommandButton({ item, onClick }: { item: Item; onClick: () => void }): React.JSX.Element {
  return (
    <button
      aria-label={`Run command for ${item.name}…`}
      title={item.runCommand ? `Run command: ${item.runCommand}` : 'Set a run command…'}
      onClick={onClick}
    >
      ▶
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

  return (
    <nav className="sidebar" inert={p.inert}>
      <div className="sidebar-scroll">
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
            <div key={theme.id} className="theme">
              <div
                className={`row theme-row${themeColorCss(theme.color) ? ' has-color' : ''}`}
                style={themeStripe(theme.color)}
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
                      <div key={item.id} className={`row item-row${isSelected(item.id) ? ' selected' : ''}`}>
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
                      <div key={item.id}>
                        <div className="row item-row">
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
                                className={`row task-row${isSelected(item.id, task.id) ? ' selected' : ''}`}
                              >
                                <button
                                  className="row-label"
                                  title={task.notes}
                                  onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id, taskId: task.id })}
                                >
                                  {dot(task.id)} {task.name}
                                </button>
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
