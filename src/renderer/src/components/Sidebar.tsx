import type { AppState, LiveStatus, Target } from '../../../shared/types'
import { filterSidebar } from '../lib/sidebarFilter'
import { shortcutLabel } from '../lib/shortcuts'

export interface SidebarProps {
  state: AppState
  status: LiveStatus
  selected: Target | null
  /** Ids of collapsed themes and repos. App owns this, since Mod+1..9 counts only visible entries. */
  collapsed: ReadonlySet<string>
  onToggleCollapsed: (id: string) => void
  /** The filter box's text; App owns it too, for the same reason. */
  filter: string
  onFilterChange: (filter: string) => void
  filterRef?: React.Ref<HTMLInputElement>
  onSelect: (target: Target) => void
  onAddTheme: () => void
  onRenameTheme: (themeId: string, currentName: string) => void
  onRemoveTheme: (themeId: string) => void
  onAddRepo: (themeId: string) => void
  onAddFolder: (themeId: string) => void
  onRemoveItem: (themeId: string, itemId: string) => void
  onAddTask: (themeId: string, repoId: string) => void
  onRenameTask: (themeId: string, repoId: string, taskId: string, currentName: string) => void
  onRemoveTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
  onOpenSettings: () => void
  onOpenUsage: () => void
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
  const running = new Set(p.status.running)
  const missing = new Set(p.status.missing)
  const arrow = (id: string): string => (expanded(id) ? '▼' : '▶')
  const dot = (id: string): React.JSX.Element =>
    missing.has(id) ? (
      <span className="dot missing" title="Path missing">
        ⚠
      </span>
    ) : running.has(id) ? (
      <span className="dot running" title="Session running">
        ●
      </span>
    ) : (
      <span className="dot idle" title="No session">
        ○
      </span>
    )
  const isSelected = (itemId: string, taskId?: string): boolean =>
    p.selected?.itemId === itemId && p.selected?.taskId === taskId

  return (
    <nav className="sidebar">
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
              <div className="row theme-row">
                <button className="row-label" onClick={() => toggle(theme.id)}>
                  {arrow(theme.id)} {theme.name}
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
                    aria-label={`Add folder to ${theme.name}`}
                    title="Add folder"
                    onClick={() => p.onAddFolder(theme.id)}
                  >
                    📁+
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
                            .filter((task) => shown('tasks', task.id))
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
                                <span className="row-actions">
                                  <button
                                    aria-label={`Rename task ${task.name}`}
                                    title="Rename task"
                                    onClick={() => p.onRenameTask(theme.id, item.id, task.id, task.name)}
                                  >
                                    ✎
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
