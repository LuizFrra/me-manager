import type { AppState, LiveStatus, Target } from '../../../shared/types'

export interface SidebarProps {
  state: AppState
  status: LiveStatus
  selected: Target | null
  /** Ids of collapsed themes and repos. App owns this, since Mod+1..9 counts only visible entries. */
  collapsed: ReadonlySet<string>
  onToggleCollapsed: (id: string) => void
  onSelect: (target: Target) => void
  onAddTheme: () => void
  onRemoveTheme: (themeId: string) => void
  onAddRepo: (themeId: string) => void
  onAddFolder: (themeId: string) => void
  onRemoveItem: (themeId: string, itemId: string) => void
  onAddTask: (themeId: string, repoId: string) => void
  onRemoveTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
}

export function Sidebar(p: SidebarProps): React.JSX.Element {
  const { collapsed, onToggleCollapsed: toggle } = p
  const running = new Set(p.status.running)
  const missing = new Set(p.status.missing)
  const arrow = (id: string): string => (collapsed.has(id) ? '▶' : '▼')
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
      <div className="sidebar-header">
        <span>THEMES</span>
        <button aria-label="New theme" title="New theme" onClick={p.onAddTheme}>
          +
        </button>
      </div>
      {p.state.themes.length === 0 && <p className="hint">Create a theme to get started.</p>}
      {p.state.themes.map((theme) => (
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
                aria-label={`Remove theme ${theme.name}`}
                title="Remove theme"
                onClick={() => p.onRemoveTheme(theme.id)}
              >
                ×
              </button>
            </span>
          </div>
          {!collapsed.has(theme.id) &&
            theme.items.map((item) =>
              item.kind === 'folder' ? (
                <div key={item.id} className={`row item-row${isSelected(item.id) ? ' selected' : ''}`}>
                  <button className="row-label" onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id })}>
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
                  {!collapsed.has(item.id) &&
                    item.tasks.map((task) => (
                      <div key={task.id} className={`row task-row${isSelected(item.id, task.id) ? ' selected' : ''}`}>
                        <button
                          className="row-label"
                          onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id, taskId: task.id })}
                        >
                          {dot(task.id)} {task.name}
                        </button>
                        <span className="row-actions">
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
    </nav>
  )
}
