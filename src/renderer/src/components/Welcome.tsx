import { useEffect, useMemo, useState } from 'react'
import type { AppState, LiveStatus, Target } from '../../../shared/types'
import { homeTips, recentTasks, TIP_ROTATE_MS } from '../lib/onboarding'
import { SESSION_STATE_INFO, sessionState } from '../lib/sessionState'
import { shortcutLabel } from '../lib/shortcuts'

export interface StartActions {
  onCreateTheme: () => void
  onAddRepo: () => void
  onCloneRepo: () => void
}

/** The first-run screen, while there are no themes: what the app organizes, and three ways to start. */
export function Welcome(p: StartActions & { onShowShortcuts: () => void }): React.JSX.Element {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div className="welcome-inner">
        <h1 id="welcome-title">Welcome to me-manager</h1>
        <p className="welcome-lead">Organize your Claude Code work by what it is for.</p>
        <ol className="welcome-model" aria-label="How work is organized">
          <li>
            <span className="welcome-model-icon" aria-hidden="true">
              🗂
            </span>
            <span>
              <strong>Themes</strong> group your work: a client, a product, side projects.
            </span>
          </li>
          <li>
            <span className="welcome-model-icon" aria-hidden="true">
              📦
            </span>
            <span>
              <strong>Repositories and folders</strong> go into a theme.
            </span>
          </li>
          <li>
            <span className="welcome-model-icon" aria-hidden="true">
              ⎇
            </span>
            <span>
              <strong>Tasks</strong> live in a repository. Each one is its own git worktree and branch, with its own
              Claude session, so several can run side by side.
            </span>
          </li>
        </ol>
        <div className="welcome-actions">
          <button className="welcome-action primary-action" onClick={p.onCreateTheme}>
            <span className="welcome-action-icon" aria-hidden="true">
              ＋
            </span>
            <span className="welcome-action-text">
              <span className="welcome-action-title">Create a theme</span>
              <span className="welcome-action-hint">Start with an empty theme</span>
            </span>
          </button>
          <button className="welcome-action" onClick={p.onAddRepo}>
            <span className="welcome-action-icon" aria-hidden="true">
              📦
            </span>
            <span className="welcome-action-text">
              <span className="welcome-action-title">Add a repository</span>
              <span className="welcome-action-hint">A git repository already on this computer</span>
            </span>
          </button>
          <button className="welcome-action" onClick={p.onCloneRepo}>
            <span className="welcome-action-icon" aria-hidden="true">
              ⤓
            </span>
            <span className="welcome-action-text">
              <span className="welcome-action-title">Clone a repository</span>
              <span className="welcome-action-hint">From GitHub or any git URL</span>
            </span>
          </button>
        </div>
        <p className="welcome-footer">
          <button className="link-button" onClick={p.onShowShortcuts}>
            Keyboard shortcuts
          </button>
          <span aria-hidden="true"> · </span>
          <span>
            Command palette <kbd>{shortcutLabel('palette')}</kbd>
          </span>
        </p>
      </div>
    </section>
  )
}

/** A tip line that changes every TIP_ROTATE_MS, or on "Next tip". */
function TipLine(): React.JSX.Element {
  const tips = useMemo(() => homeTips(), [])
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1) % tips.length), TIP_ROTATE_MS)
    return () => clearInterval(timer)
  }, [tips.length])
  return (
    <p className="home-tip">
      <span className="home-tip-label">Tip</span>
      <span className="home-tip-text" aria-live="polite">
        {tips[index]}
      </span>
      <button
        className="home-tip-next"
        aria-label="Next tip"
        title="Next tip"
        onClick={() => setIndex((i) => (i + 1) % tips.length)}
      >
        ›
      </button>
    </p>
  )
}

/**
 * The main area while themes exist but nothing is selected: the newest tasks to reopen, quick actions and a tip.
 */
export function Home(
  p: StartActions & {
    state: AppState
    status: LiveStatus
    onOpen: (target: Target) => void
    onOpenPalette: () => void
  },
): React.JSX.Element {
  const recent = recentTasks(p.state)
  return (
    <section className="home" aria-label="Home">
      <div className="home-inner">
        <p className="home-title">Select a task or folder, or create one from the sidebar.</p>
        {recent.length > 0 && (
          <div className="home-section">
            <h2>Recent tasks</h2>
            <ul className="home-recent">
              {recent.map(({ target, task, theme, repoName }) => {
                const session = sessionState(p.status, task.id)
                const dot =
                  session === 'none' || session === 'missing' || session === 'running' ? session : `running ${session}`
                return (
                  <li key={task.id}>
                    <button
                      className="home-recent-task"
                      aria-label={`Open ${task.name} (${theme.name} › ${repoName})`}
                      onClick={() => p.onOpen(target)}
                    >
                      <span className={`dot ${dot}`} aria-hidden="true">
                        {SESSION_STATE_INFO[session].glyph}
                      </span>
                      <span className="home-recent-name">{task.name}</span>
                      <span className="home-recent-where">
                        {theme.icon && <span aria-hidden="true">{theme.icon} </span>}
                        {theme.name} › {repoName}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <div className="home-section">
          <h2>Quick actions</h2>
          <div className="home-actions">
            <button onClick={p.onAddRepo}>
              <span aria-hidden="true">📦</span> Add a repository
            </button>
            <button onClick={p.onCloneRepo}>
              <span aria-hidden="true">⤓</span> Clone a repository
            </button>
            <button onClick={p.onCreateTheme}>
              <span aria-hidden="true">＋</span> Create a theme
            </button>
            <button onClick={p.onOpenPalette}>
              <span aria-hidden="true">⌕</span> Command palette <kbd>{shortcutLabel('palette')}</kbd>
            </button>
          </div>
        </div>
        <TipLine />
      </div>
    </section>
  )
}
