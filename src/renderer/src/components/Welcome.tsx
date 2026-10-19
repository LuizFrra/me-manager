import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, FolderDown, FolderGit2, GitBranch, Layers, Plus, Search } from 'lucide-react'
import { MAX_TASK_PROMPT, type AppState, type LiveStatus, type Target } from '../../../shared/types'
import { targetKey } from '../../../shared/naming'
import { waitingTargets } from '../lib/attention'
import { defaultRepo, greeting, repoChoices, taskNameFromPrompt } from '../lib/composer'
import { homeTips, recentTasks, timeAgo, TIP_ROTATE_MS } from '../lib/onboarding'
import { SESSION_STATE_INFO, sessionState } from '../lib/sessionState'
import { shortcutLabel } from '../lib/shortcuts'
import { ICON } from '../lib/icon'
import { Spark } from './icons'

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
        <div className="welcome-mark">
          <Spark size={36} />
        </div>
        <h1 id="welcome-title">Welcome to me-manager</h1>
        <p className="welcome-lead">Organize your Claude Code work by what it is for.</p>
        <ol className="welcome-model" aria-label="How work is organized">
          <li>
            <span className="welcome-model-icon">
              <Layers {...ICON} size={16} />
            </span>
            <span>
              <strong>Themes</strong> group your work: a client, a product, side projects.
            </span>
          </li>
          <li>
            <span className="welcome-model-icon">
              <FolderGit2 {...ICON} size={16} />
            </span>
            <span>
              <strong>Repositories and folders</strong> go into a theme.
            </span>
          </li>
          <li>
            <span className="welcome-model-icon">
              <GitBranch {...ICON} size={16} />
            </span>
            <span>
              <strong>Tasks</strong> live in a repository. Each one is its own git worktree and branch, with its own
              Claude session, so several can run side by side.
            </span>
          </li>
        </ol>
        <div className="welcome-actions">
          <button className="welcome-action primary-action" onClick={p.onCreateTheme}>
            <span className="welcome-action-icon">
              <Plus {...ICON} size={18} />
            </span>
            <span className="welcome-action-text">
              <span className="welcome-action-title">Create a theme</span>
              <span className="welcome-action-hint">Start with an empty theme</span>
            </span>
          </button>
          <button className="welcome-action" onClick={p.onAddRepo}>
            <span className="welcome-action-icon">
              <FolderGit2 {...ICON} size={18} />
            </span>
            <span className="welcome-action-text">
              <span className="welcome-action-title">Add a repository</span>
              <span className="welcome-action-hint">A git repository already on this computer</span>
            </span>
          </button>
          <button className="welcome-action" onClick={p.onCloneRepo}>
            <span className="welcome-action-icon">
              <FolderDown {...ICON} size={18} />
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
 * Claude-style: start a task by saying what it is for. The prompt becomes the task's first message, and its first
 * words the task's name (taskNameFromPrompt). Enter starts it, Shift+Enter adds a line.
 */
function Composer(p: {
  state: AppState
  focus: number
  onStart: (themeId: string, repoId: string, prompt: string) => Promise<boolean>
  /** Opens the New task dialog (base branch, templates) with what the composer holds. */
  onMoreOptions: (themeId: string, repoId: string, prompt: string) => void
}): React.JSX.Element {
  const choices = repoChoices(p.state)
  const [choice, setChoice] = useState(() => {
    const d = defaultRepo(p.state)
    return d ? `${d.themeId}/${d.repoId}` : ''
  })
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [p.focus])
  // The chosen repository may be removed meanwhile: fall back to the first one.
  const current = choices.find((c) => `${c.themeId}/${c.repoId}` === choice) ?? choices[0]
  const repo = current
    ? p.state.themes.find((t) => t.id === current.themeId)?.items.find((i) => i.id === current.repoId)
    : undefined
  const taken = repo?.kind === 'repo' ? repo.tasks.map((t) => t.slug) : []
  const text = prompt.trim()
  const tooLong = text.length > MAX_TASK_PROMPT
  const name = text ? taskNameFromPrompt(text, taken) : ''
  const start = async (): Promise<void> => {
    if (!current || !text || tooLong || busy) return
    setBusy(true)
    const ok = await p.onStart(current.themeId, current.repoId, text)
    setBusy(false)
    if (ok) setPrompt('')
  }
  return (
    <form
      className={`composer${busy ? ' busy' : ''}`}
      aria-label="New task"
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
    >
      <textarea
        ref={input}
        className="composer-input"
        aria-label="What should Claude work on?"
        placeholder="What should Claude work on?"
        rows={3}
        value={prompt}
        readOnly={busy}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
          e.preventDefault()
          void start()
        }}
      />
      <div className="composer-bar">
        <span className="composer-repo">
          <FolderGit2 {...ICON} />
          <select
            aria-label="Repository"
            value={current ? `${current.themeId}/${current.repoId}` : ''}
            disabled={busy}
            onChange={(e) => setChoice(e.target.value)}
          >
            {choices.map((c) => (
              <option key={`${c.themeId}/${c.repoId}`} value={`${c.themeId}/${c.repoId}`}>
                {c.label}
              </option>
            ))}
          </select>
        </span>
        <span className="composer-name" aria-live={busy || tooLong ? 'polite' : 'off'}>
          {busy ? (
            'Creating the worktree…'
          ) : tooLong ? (
            <span className="composer-error">Use at most {MAX_TASK_PROMPT.toLocaleString('en')} characters.</span>
          ) : name ? (
            <>
              New task <strong>{name}</strong>
            </>
          ) : null}
        </span>
        <button
          type="button"
          className="composer-options"
          title="Choose the base branch or a template"
          disabled={busy || !current}
          onClick={() => current && p.onMoreOptions(current.themeId, current.repoId, prompt)}
        >
          Options…
        </button>
        <button
          type="submit"
          className="composer-send"
          aria-label="Start task"
          title="Start the task (Enter)"
          disabled={!text || tooLong || busy}
        >
          <ArrowUp {...ICON} size={16} strokeWidth={2.25} />
        </button>
      </div>
    </form>
  )
}

/**
 * The main area while themes exist but nothing is selected: a greeting, the composer that starts a task from a
 * prompt, the newest tasks to reopen, quick actions and a tip.
 */
export function Home(
  p: StartActions & {
    state: AppState
    status: LiveStatus
    onOpen: (target: Target) => void
    onOpenPalette: () => void
    onStartTask: (themeId: string, repoId: string, prompt: string) => Promise<boolean>
    onMoreTaskOptions: (themeId: string, repoId: string, prompt: string) => void
    /** Bumped to focus the composer (New task). */
    composerFocus: number
  },
): React.JSX.Element {
  const recent = recentTasks(p.state)
  const waiting = waitingTargets(p.state, p.status)
  const now = new Date()
  const hasRepos = repoChoices(p.state).length > 0
  return (
    <section className="home" aria-label="Home">
      <div className="home-inner">
        <h1 className="home-greeting">
          <Spark size={30} />
          {greeting(now)}
        </h1>
        {hasRepos ? (
          <Composer
            state={p.state}
            focus={p.composerFocus}
            onStart={p.onStartTask}
            onMoreOptions={p.onMoreTaskOptions}
          />
        ) : (
          <p className="home-title">Add a repository to start tasks, or select a folder in the sidebar.</p>
        )}
        {waiting.length > 0 && (
          <div className="home-section home-waiting">
            <h2>Waiting for you</h2>
            <div className="home-waiting-list">
              {waiting.map(({ target, label }) => (
                <button
                  key={targetKey(target)}
                  className="home-waiting-item"
                  aria-label={`Open ${label}, waiting for you`}
                  onClick={() => p.onOpen(target)}
                >
                  <span className="dot running waiting" aria-hidden="true">
                    ●
                  </span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
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
                      <span className="home-recent-when">{timeAgo(task.createdAt, now)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <div className="home-actions">
          <button onClick={p.onAddRepo}>
            <FolderGit2 {...ICON} /> Add a repository
          </button>
          <button onClick={p.onCloneRepo}>
            <FolderDown {...ICON} /> Clone a repository
          </button>
          <button onClick={p.onCreateTheme}>
            <Plus {...ICON} /> Create a theme
          </button>
          <button onClick={p.onOpenPalette}>
            <Search {...ICON} /> Command palette <kbd>{shortcutLabel('palette')}</kbd>
          </button>
        </div>
        <TipLine />
      </div>
    </section>
  )
}
