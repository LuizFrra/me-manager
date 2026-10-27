import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { checkCloneName, checkCloneUrl } from '../../shared/clone'
import {
  isArchived,
  MAX_CLAUDE_MESSAGE,
  MAX_COMMIT_MESSAGE,
  MAX_TASK_PROMPT,
  MAX_TRANSCRIPT_BYTES,
} from '../../shared/types'
import type {
  AppState,
  BranchList,
  BudgetReport,
  BudgetStatus,
  DevUrl,
  ChangeList,
  ChangeScope,
  ClaudeActivity,
  CommitResult,
  GitTools,
  FileContent,
  Item,
  FileList,
  LiveStatus,
  NewTaskOptions,
  PullRequestResult,
  PushResult,
  Repo,
  SearchOptions,
  SearchResult,
  Settings,
  SettingsView,
  TabInfo,
  Target,
  Task,
  TaskGitStatus,
  Theme,
  ThemeStyle,
  Transcript,
  UnsavedWork,
  UpdateResult,
  UiState,
  UpdateStrategy,
  UsageReport,
  UsageSummary,
  UsageTargetReport,
} from '../../shared/types'
import { budgetStatus, effectiveTaskBudget } from '../../shared/budget'
import { builtInClaudeFlags, effectiveClaudeFlags } from '../../shared/settings'
import { emptyUsageSummary } from '../../shared/usage'
import { normalizeUiState } from '../../shared/uiState'
import { branchName, sessionName, targetKey } from '../../shared/naming'
import { shellQuote } from '../../shared/shell'
import { RUN_WINDOW } from '../../shared/runCommand'
import { findDevUrls, MAX_DEV_URLS } from '../../shared/devUrls'
import { mapLimit } from '../concurrency'
import type { AppService, CapturedTranscript, OrchestratorDeps, UsageSummaries } from '../contracts'
import { baseBranchName } from '../git/gh'
import { taskWorktreePath } from '../paths'
import { promptFromFile } from '../promptFiles'
import * as m from '../store/mutations'
import { isRecentlyActive, looksWaiting } from '../tmux/activity'
import { transcriptFileName } from '../transcript'

/**
 * The shell string tmux runs to start Claude with the user's extra arguments (Settings.claudeArgs). tmux hands
 * it to a shell, so every argument is shell-quoted: `$(…)`, `;` or spaces in an argument stay literal.
 */
export const claudeCommand = (args: readonly string[] = []): string => ['claude', ...args].map(shellQuote).join(' ')
/**
 * The prompt as Claude's positional argument. Claude reads a lone one-word positional as a subcommand even after
 * `--` (`claude -- mcp` runs `claude mcp`, `claude -- purge` would delete the project's state) and refuses a word
 * close to one (`mcpx`: "unknown command"). A trailing space makes it never a single word, for any prompt.
 */
export const promptArgument = (prompt: string): string => `${prompt} `
/**
 * The first start of a task's Claude with an initial prompt: Claude's positional `[prompt]` argument, after `--`
 * so that neither a prompt starting with '-' nor a variadic option in the user's arguments (`--add-dir a b`) can
 * swallow or misread it. The prompt itself is read from `promptFile` (see PromptFiles, which holds
 * promptArgument(prompt)), as tmux can't take a long one in the command. Restarts use claudeContinueCommand,
 * which never repeats the prompt.
 */
export const claudePromptCommand = (args: readonly string[], promptFile: string | undefined): string =>
  promptFile === undefined ? claudeCommand(args) : `${claudeCommand([...args, '--'])} ${promptFromFile(promptFile)}`
/**
 * `--continue` fails when there is no previous conversation; fall back to a fresh one. With a `promptFile` (only
 * to hand Claude a request when its window is restarted for one), both carry it as claudePromptCommand does.
 */
export const claudeContinueCommand = (args: readonly string[] = [], promptFile?: string): string =>
  `${claudePromptCommand([...args, '--continue'], promptFile)} || ${claudePromptCommand(args, promptFile)}`

export const CLAUDE_CMD = claudeCommand()
export const CLAUDE_CONTINUE_CMD = claudeContinueCommand()
const CLAUDE_WINDOW = 'claude'
/** How long createTask waits for `git fetch` before branching from the last fetched refs. */
export const FETCH_TIMEOUT_MS = 20_000

/**
 * The shell command of a `run` tab: the item's run command line, as typed, after a `$ <command>` line that shows
 * what runs. Only the command itself is shell: in that line it is one shell-quoted word. tmux runs this with the
 * user's shell (`default-shell -c`, which is $SHELL) in the worktree or folder, and keeps the tab open with its
 * output once the command exits (remain-on-exit, set for that tab only: see TmuxApi.newWindow), rather than
 * `…; exec $SHELL`, so that a stopped command reads as stopped (`#{pane_dead}`) and Restart can run it again in
 * place (`respawn-window -k`).
 */
export const runWindowCommand = (command: string): string => `printf '$ %s\\n' ${shellQuote(command)}; ${command}`
/** How long Restart waits after Ctrl-C, so a dev server can shut down (and free its port) before it runs again. */
export const RUN_RESTART_GRACE_MS = 500

/** How much of each tab getDevUrls reads: its screen and this many lines of scrollback above it. */
export const DEV_URL_SCROLLBACK_LINES = 200
/** A tab that keeps printing (a busy log) is captured again for getDevUrls at most this often. */
export const DEV_URL_RESCAN_MS = 3_000

/** One tab's last capture for getDevUrls. */
interface DevUrlScan {
  /** The tab's `window_activity` (Unix seconds) when it was captured. */
  activity: number
  /** When it was captured, in ms. */
  at: number
  /** Its URLs, newest first. */
  urls: string[]
}

/**
 * Whether a tab may have printed something its last capture doesn't have: it printed since, or in the second of the
 * capture itself (tmux reports whole seconds, so output later in that second has the same activity time).
 */
const mayHaveChanged = (scan: DevUrlScan, activity: number): boolean =>
  activity !== scan.activity || activity >= Math.floor(scan.at / 1000)

/**
 * A worktree's git status is read at most this often, however fast the UI polls: each read runs a few git
 * commands, which add up in big repos.
 */
export const GIT_STATUS_TTL_MS = 5_000
/** Worktrees whose git status is read at the same time. */
export const GIT_STATUS_CONCURRENCY = 4
/** Quiet `claude` windows whose screen is captured at the same time (see getStatus). */
export const PANE_CAPTURE_CONCURRENCY = 4

/**
 * createTask's options as sent over IPC (so not trusted to match NewTaskOptions): trimmed, with empty values
 * dropped. Throws on wrong types, a prompt over MAX_TASK_PROMPT characters, or a NUL in either value.
 */
export function normalizeTaskOptions(raw: unknown): NewTaskOptions {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid task options')
  const { baseRef, prompt } = raw as Record<string, unknown>
  const text = (value: unknown, what: string): string | undefined => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid ${what}`)
    return value.trim() || undefined
  }
  const options: NewTaskOptions = {}
  const ref = text(baseRef, 'base branch')
  if (ref !== undefined) options.baseRef = ref
  const first = text(prompt, 'initial prompt')
  if (first !== undefined) {
    if (first.length > MAX_TASK_PROMPT)
      throw new Error(`The initial prompt is limited to ${MAX_TASK_PROMPT.toLocaleString('en-US')} characters`)
    options.prompt = first
  }
  return options
}

/** Most conflicting files named in the request to Claude, and the longest name kept. */
export const MAX_RESOLVE_FILES = 100
const MAX_RESOLVE_PATH = 500

/**
 * The request typed into Claude's window after an update stopped on conflicts. The files come from the renderer:
 * control characters (a newline would send the message early) are replaced and the list is capped.
 */
export function resolvePrompt(strategy: UpdateStrategy, baseRef: string, files: unknown): string {
  if (strategy !== 'rebase' && strategy !== 'merge') throw new Error('Invalid update strategy')
  const names = (Array.isArray(files) ? files : [])
    .filter((f): f is string => typeof f === 'string' && f !== '')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .map((f) => f.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, MAX_RESOLVE_PATH))
  if (names.length === 0) throw new Error('No conflicting files to resolve')
  const shown = names.slice(0, MAX_RESOLVE_FILES).join(', ')
  const more = names.length > MAX_RESOLVE_FILES ? ` and ${names.length - MAX_RESOLVE_FILES} more` : ''
  const action = strategy === 'rebase' ? `rebase this branch onto ${baseRef}` : `merge ${baseRef} into this branch`
  return `Please ${action} and resolve the conflicts in: ${shown}${more}`
}

/**
 * Text for sendToClaude, from the renderer: line endings made `\n`, other control characters but tabs replaced
 * (an ESC could end the bracketed paste early, after which a newline would be read as Enter), and trimmed. Throws
 * when nothing is left or it is over MAX_CLAUDE_MESSAGE characters.
 */
export function claudeMessage(text: unknown): string {
  const clean = (typeof text === 'string' ? text : '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?')
    .trim()
  if (!clean) throw new Error('Nothing to send to Claude')
  if (clean.length > MAX_CLAUDE_MESSAGE)
    throw new Error(`The message for Claude is limited to ${MAX_CLAUDE_MESSAGE.toLocaleString('en-US')} characters`)
  return clean
}

/** The usage group of a theme's targets. */
const themeGroup = (themeId: string): string => `theme:${themeId}`

/** Settings as the renderer gets them: with the built-in Claude flags that apply. */
const withEffective = (settings: Settings): SettingsView => ({ ...settings, effective: effectiveClaudeFlags(settings) })

/** What archiving a task with uncommitted or untracked files (or a worktree it could not check) is refused with. */
export const ARCHIVE_REFUSAL = 'Commit or discard the changes first'

/** Refuses the target's sessions, worktree and git: an archived task has neither, until it is restored. */
function assertNotArchived(task: Task): void {
  if (isArchived(task)) throw new Error(`"${task.name}" is archived: restore it first`)
}

const STATE_QUEUE = 'state'
const taskQueue = (taskId: string): string => `task:${taskId}`
/** Run, Restart and Stop on one session go one at a time, so two clicks never open two run tabs. */
const runQueue = (session: string): string => `run:${session}`

export interface OrchestratorOptions {
  /** Overrides FETCH_TIMEOUT_MS (for tests). */
  fetchTimeoutMs?: number
  /** The clock, in ms (for tests). */
  now?: () => number
  /** Overrides RUN_RESTART_GRACE_MS (for tests). */
  runGraceMs?: number
}

interface GitStatusEntry {
  at: number
  baseRef: string
  /** null when the read failed; kept for the TTL too, so a broken worktree isn't retried on every poll. */
  status: Promise<TaskGitStatus | null>
}

export class Orchestrator implements AppService {
  private state: AppState = m.emptyState()
  private current: Target | null = null
  /**
   * Tails of the mutation queues, by key: STATE_QUEUE for app state, `task:<id>` for git actions on one task. A
   * tail always resolves, so a failure never blocks later calls; an idle queue's entry is removed.
   */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly fetchTimeoutMs: number
  private readonly runGraceMs: number
  /** Bumped by every openTarget call, so only the latest one attaches the terminal. */
  private openSeq = 0
  private readonly now: () => number
  /** Git status per worktree path, shared by overlapping calls and reused for GIT_STATUS_TTL_MS. */
  private readonly gitStatusCache = new Map<string, GitStatusEntry>()
  /**
   * Whether a quiet session's screen showed a waiting prompt, by session, with the `window_activity` it was
   * captured at: the screen can't change without new activity, so it is captured again only after some.
   */
  private readonly waitingCache = new Map<string, { activitySec: number; waiting: boolean }>()
  /**
   * getDevUrls' last capture of each tab (by window id) of the session it last scanned; only the selected target is
   * polled, so one session's are kept.
   */
  private devUrlScans: { session: string; tabs: Map<string, DevUrlScan> } | null = null
  /** The search running for each target (by targetKey): a newer one there aborts it. */
  private readonly searches = new Map<string, AbortController>()

  constructor(
    private readonly deps: OrchestratorDeps,
    options: OrchestratorOptions = {},
  ) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.runGraceMs = options.runGraceMs ?? RUN_RESTART_GRACE_MS
  }

  async init(): Promise<void> {
    this.state = await this.deps.store.load()
  }

  private async commit(next: AppState): Promise<AppState> {
    await this.deps.store.save(next)
    this.state = next
    return next
  }

  /** commit, unless the mutation handed back the state as it is (a move to where the entry already was). */
  private async commitIfChanged(next: AppState): Promise<AppState> {
    return next === this.state ? next : this.commit(next)
  }

  /**
   * Runs state-changing operations one at a time: FileStore.save is not safe to call
   * concurrently, and overlapping operations would read stale state (lost updates,
   * duplicate tasks passing the slug check).
   *
   * `key` picks the queue: git actions on a task (commit, push, PR) queue per task, so a slow push neither
   * overlaps another action on that worktree nor holds up the rest of the app.
   */
  private exclusive<T>(op: () => Promise<T>, key = STATE_QUEUE): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(op)
    const tail = run.then(
      () => {},
      () => {},
    )
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  /** Fetch, but give up after fetchTimeoutMs (hung network, ssh prompt). Never throws. */
  private async fetchWithTimeout(repoPath: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.fetchTimeoutMs)
    })
    try {
      await Promise.race([this.deps.git.fetch(repoPath), timeout])
    } catch {
      // Offline or auth problem: branch from the last fetched refs instead of failing.
    } finally {
      clearTimeout(timer)
    }
  }

  /** The tmux session, working folder and Remote Control label (`<theme>/<repo>/<task>`) of a target. */
  private resolve(target: Target): { session: string; cwd: string; label: string } {
    const theme = m.getTheme(this.state, target.themeId)
    const item = m.getItem(this.state, target.themeId, target.itemId)
    if (item.kind === 'folder') {
      return { session: sessionName(theme.slug, item.slug), cwd: item.path, label: `${theme.slug}/${item.slug}` }
    }
    if (!target.taskId) throw new Error('Choose a task to open')
    const task = m.getTask(this.state, theme.id, item.id, target.taskId)
    assertNotArchived(task)
    return {
      session: sessionName(theme.slug, item.slug, task.slug),
      cwd: task.worktreePath,
      label: `${theme.slug}/${item.slug}/${task.slug}`,
    }
  }

  /**
   * Arguments for starting Claude in a session labelled `label` (`<theme>/<repo>/<task>` or `<theme>/<folder>`):
   * the Remote Control and skip-permissions flags when enabled, then the user's own arguments. A flag is left out
   * when the user's arguments already set that option. Read at each start, so a change applies to the next session.
   */
  private claudeArgs(label: string): string[] {
    const settings = this.deps.settings.get()
    return [...builtInClaudeFlags(settings, label), ...settings.claudeArgs]
  }

  /**
   * Runs `start` (a tmux call starting `claude`) with `prompt` in a private file (see claudePromptCommand), or
   * without a file when there is no prompt. The file is removed once the command had time to read it, or right
   * away when `start` fails.
   */
  private async withPromptFile<T>(
    prompt: string | undefined,
    start: (promptFile: string | undefined) => Promise<T>,
  ): Promise<T> {
    if (prompt === undefined) return start(undefined)
    const { promptFiles } = this.deps
    const file = await promptFiles.write(promptArgument(prompt))
    try {
      const result = await start(file)
      promptFiles.release(file)
      return result
    } catch (err) {
      promptFiles.release(file, true)
      throw err
    }
  }

  private detachIf(pred: (t: Target) => boolean): void {
    if (this.current && pred(this.current)) {
      this.deps.pty.detach()
      this.current = null
    }
  }

  async getState(): Promise<AppState> {
    return this.state
  }

  /** The target the terminal is attached to (what the user has selected), or null. Main-process only. */
  currentTarget(): Target | null {
    return this.current
  }

  /** Checked against the current state, so a removed task or theme is never handed back. */
  async getUiState(): Promise<UiState> {
    return normalizeUiState(await this.deps.ui.load(), this.state)
  }

  /** From the renderer: normalized before it is written. Doesn't wait for state mutations. */
  async saveUiState(state: UiState): Promise<void> {
    await this.deps.ui.save(normalizeUiState(state, this.state))
  }

  async getSettings(): Promise<SettingsView> {
    return withEffective(this.deps.settings.get())
  }

  /**
   * Settings have their own file and queue, so this doesn't wait for state mutations. A patch's `effective` (the
   * renderer may send back what it got) is dropped by normalizeSettings like any unknown key.
   */
  async updateSettings(patch: Partial<Settings>): Promise<SettingsView> {
    return withEffective(await this.deps.settings.update(patch))
  }

  /**
   * Sessions, missing folders and Claude's activity. Kept cheap for polling: two tmux calls, plus a screen capture
   * only for a quiet session whose window printed something since its last capture. Archived tasks are left out:
   * their worktree is gone on purpose, and they have no session.
   */
  async getStatus(): Promise<LiveStatus> {
    const [sessionList, activityBySession] = await Promise.all([
      this.deps.tmux.listSessions().catch(() => [] as string[]),
      this.deps.tmux.windowActivity(CLAUDE_WINDOW).catch(() => ({}) as Record<string, number>),
    ])
    const sessions = new Set(sessionList)
    const running: string[] = []
    const missing: string[] = []
    const live: { id: string; session: string }[] = []
    const check = (id: string, session: string): void => {
      if (!sessions.has(session)) return
      running.push(id)
      live.push({ id, session })
    }
    for (const theme of this.state.themes) {
      for (const item of theme.items) {
        if (!this.deps.pathExists(item.path)) missing.push(item.id)
        if (item.kind === 'folder') {
          check(item.id, sessionName(theme.slug, item.slug))
          continue
        }
        for (const task of item.tasks) {
          if (isArchived(task)) continue
          if (!this.deps.pathExists(task.worktreePath)) missing.push(task.id)
          check(task.id, sessionName(theme.slug, item.slug, task.slug))
        }
      }
    }
    return { running, missing, activity: await this.claudeActivity(live, activityBySession) }
  }

  /** Busy from recent output; otherwise waiting or idle from the screen (see tmux/activity.ts). */
  private async claudeActivity(
    live: { id: string; session: string }[],
    activityBySession: Record<string, number>,
  ): Promise<Record<string, ClaudeActivity>> {
    const nowMs = this.now()
    const activity: Record<string, ClaudeActivity> = {}
    const quiet: { id: string; session: string; activitySec: number }[] = []
    for (const { id, session } of live) {
      const activitySec = activityBySession[session]
      if (activitySec === undefined) continue // the claude window was closed
      if (isRecentlyActive(activitySec, nowMs)) activity[id] = 'busy'
      else quiet.push({ id, session, activitySec })
    }
    const sessions = new Set(live.map((l) => l.session))
    for (const session of this.waitingCache.keys()) if (!sessions.has(session)) this.waitingCache.delete(session)
    await mapLimit(quiet, PANE_CAPTURE_CONCURRENCY, async ({ id, session, activitySec }) => {
      let cached = this.waitingCache.get(session)
      if (cached?.activitySec !== activitySec) {
        const pane = await this.deps.tmux.capturePane(session, CLAUDE_WINDOW).catch(() => null)
        cached = { activitySec, waiting: pane !== null && looksWaiting(pane) }
        this.waitingCache.set(session, cached)
      }
      activity[id] = cached.waiting ? 'waiting' : 'idle'
    })
    return activity
  }

  async getGitStatus(targets: Target[]): Promise<Record<string, TaskGitStatus>> {
    const now = this.now()
    for (const [path, entry] of this.gitStatusCache) {
      if (now - entry.at >= GIT_STATUS_TTL_MS) this.gitStatusCache.delete(path)
    }
    const tasks = new Map<string, { root: string; baseRef: string }>()
    for (const target of Array.isArray(targets) ? targets : []) {
      if (!target?.taskId) continue
      const resolved = this.tryTargetRoot(target) // null: removed or archived meanwhile
      if (resolved?.baseRef === undefined || !this.deps.pathExists(resolved.root)) continue
      tasks.set(targetKey(target), { root: resolved.root, baseRef: resolved.baseRef })
    }
    const results = await mapLimit([...tasks], GIT_STATUS_CONCURRENCY, async ([key, { root, baseRef }]) => {
      let entry = this.gitStatusCache.get(root)
      if (!entry || entry.baseRef !== baseRef) {
        entry = { at: now, baseRef, status: this.deps.git.taskStatus(root, baseRef).catch(() => null) }
        this.gitStatusCache.set(root, entry)
      }
      return [key, await entry.status] as const
    })
    const out: Record<string, TaskGitStatus> = {}
    for (const [key, status] of results) if (status) out[key] = status
    return out
  }

  async createTheme(name: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.addTheme(this.state, name)))
  }

  async renameTheme(themeId: string, name: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.renameTheme(this.state, themeId, name)))
  }

  /** The style comes from the renderer: customizeTheme checks it. */
  async customizeTheme(themeId: string, style: ThemeStyle): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.customizeTheme(this.state, themeId, style)))
  }

  async removeTheme(themeId: string): Promise<AppState> {
    return this.exclusive(async () => {
      const next = m.removeTheme(this.state, themeId) // throws if tasks remain
      const theme = m.getTheme(this.state, themeId)
      this.detachIf((t) => t.themeId === themeId)
      for (const item of theme.items) {
        if (item.kind === 'folder') await this.deps.tmux.killSession(sessionName(theme.slug, item.slug))
      }
      return this.commit(next)
    })
  }

  /** The theme comes from the renderer: restoreTheme checks it. */
  async restoreTheme(theme: Theme, index?: number): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.restoreTheme(this.state, theme, index)))
  }

  async moveTheme(themeId: string, toIndex: number): Promise<AppState> {
    return this.exclusive(async () => this.commitIfChanged(m.moveTheme(this.state, themeId, toIndex)))
  }

  async addRepo(themeId: string, path: string): Promise<AppState> {
    return this.exclusive(async () => {
      const root = await this.deps.git.repoRoot(path)
      if (!root) throw new Error(`Not a git repository: ${path}`)
      return this.commit(m.addRepo(this.state, themeId, root))
    })
  }

  /**
   * Everything is checked before git runs: the URL, the name, the parent folder, and that the theme will take the
   * repo (its path and name are free). The clone itself runs outside the state queue, so a slow one doesn't hold
   * up other changes; the repo is added once it is done.
   */
  async cloneRepo(themeId: string, url: string, parentDir: string, name: string): Promise<AppState> {
    const checkedUrl = checkCloneUrl(url)
    const folder = checkCloneName(name)
    if (typeof parentDir !== 'string' || !isAbsolute(parentDir) || parentDir.includes('\0')) {
      throw new Error('Choose the folder to clone into')
    }
    if (!this.deps.pathExists(parentDir)) throw new Error(`Folder not found: ${parentDir}`)
    const dest = join(parentDir, folder)
    if (this.deps.pathExists(dest)) throw new Error(`${dest} already exists; choose another folder name`)
    m.addRepo(this.state, themeId, dest) // throws now, not after the clone, if the theme won't take it
    await this.deps.git.clone(checkedUrl, dest)
    const root = (await this.deps.git.repoRoot(dest)) ?? dest
    const next = await this.exclusive(async () => this.commit(m.addRepo(this.state, themeId, root))).catch((err) => {
      // The theme changed while cloning; the clone is complete, so it stays where it is.
      throw new Error(`Cloned into ${dest}, but could not add it: ${err instanceof Error ? err.message : err}`, {
        cause: err,
      })
    })
    await this.deps.settings.update({ cloneDirectory: parentDir }).catch(() => {}) // only a default for next time
    return next
  }

  async addFolder(themeId: string, path: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.addFolder(this.state, themeId, path)))
  }

  async removeItem(themeId: string, itemId: string): Promise<AppState> {
    return this.exclusive(async () => {
      const next = m.removeItem(this.state, themeId, itemId) // throws if repo has tasks
      const theme = m.getTheme(this.state, themeId)
      const item = m.getItem(this.state, themeId, itemId)
      this.detachIf((t) => t.itemId === itemId)
      if (item.kind === 'folder') await this.deps.tmux.killSession(sessionName(theme.slug, item.slug))
      return this.commit(next)
    })
  }

  /** The command comes from the renderer: setRunCommand checks it. It applies from the next Run or Restart. */
  async setRunCommand(themeId: string, itemId: string, command: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.setRunCommand(this.state, themeId, itemId, command)))
  }

  /** The item comes from the renderer: restoreItem checks it. */
  async restoreItem(themeId: string, item: Item, index?: number): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.restoreItem(this.state, themeId, item, index)))
  }

  /** Within its theme only; nothing on disk or in tmux depends on the order. */
  async moveItem(themeId: string, itemId: string, toIndex: number): Promise<AppState> {
    return this.exclusive(async () => this.commitIfChanged(m.moveItem(this.state, themeId, itemId, toIndex)))
  }

  /** The default base and every listed branch, the default first (it may be a local branch git doesn't list). */
  private async branchList(repoPath: string): Promise<BranchList> {
    const [defaultRef, branches] = await Promise.all([
      this.deps.git.resolveBaseRef(repoPath),
      this.deps.git.listBranches(repoPath),
    ])
    return { default: defaultRef, branches: [defaultRef, ...branches.filter((b) => b !== defaultRef)] }
  }

  /** Read-only (fetch only updates remote-tracking refs), so it doesn't wait for queued mutations. */
  async listBranches(themeId: string, repoId: string): Promise<BranchList> {
    const repo = m.getRepo(this.state, themeId, repoId)
    await this.fetchWithTimeout(repo.path)
    return this.branchList(repo.path)
  }

  /** The base a new task starts from: the chosen one once checked, or the repo's default. */
  private async chooseBaseRef(repoPath: string, chosen: string | undefined): Promise<string> {
    if (chosen === undefined) return this.deps.git.resolveBaseRef(repoPath)
    if (chosen.startsWith('-')) throw new Error(`Invalid base branch: ${chosen}`)
    const { branches } = await this.branchList(repoPath)
    if (!branches.includes(chosen)) throw new Error(`Unknown base branch: ${chosen}`)
    if (!(await this.deps.git.verifyRef(repoPath, chosen))) throw new Error(`Base branch not found: ${chosen}`)
    return chosen
  }

  async createTask(themeId: string, repoId: string, name: string, options?: NewTaskOptions): Promise<AppState> {
    return this.exclusive(async () => {
      const { git, tmux } = this.deps
      const theme = m.getTheme(this.state, themeId)
      const repo = m.getRepo(this.state, themeId, repoId)
      const slug = m.requireSlug(name, 'Task')
      m.assertTaskSlugFree(repo, slug)
      m.assertTaskNameFree(repo, name)
      const { baseRef: chosenBase, prompt } = normalizeTaskOptions(options)
      const branch = branchName(theme.slug, slug)
      const worktreePath = taskWorktreePath(theme.slug, repo.slug, slug, this.deps.worktreesRoot)
      const session = sessionName(theme.slug, repo.slug, slug)

      await this.fetchWithTimeout(repo.path)
      const baseRef = await this.chooseBaseRef(repo.path, chosenBase)
      await git.addWorktree(repo.path, worktreePath, branch, baseRef)
      try {
        const args = this.claudeArgs(`${theme.slug}/${repo.slug}/${slug}`)
        await this.withPromptFile(prompt, (file) =>
          tmux.newSession(session, worktreePath, CLAUDE_WINDOW, claudePromptCommand(args, file)),
        )
        const task: Task = {
          id: randomUUID(),
          name: name.trim(),
          slug,
          branch,
          worktreePath,
          baseRef,
          createdAt: new Date().toISOString(),
        }
        return await this.commit(m.addTask(this.state, themeId, repoId, task))
      } catch (err) {
        await tmux.killSession(session).catch(() => {})
        await git.removeWorktree(repo.path, worktreePath).catch(() => {})
        await git.deleteBranch(repo.path, branch).catch(() => {})
        throw err
      }
    })
  }

  /** Display name only: the branch, worktree and tmux session keep the original slug. */
  async renameTask(themeId: string, repoId: string, taskId: string, name: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.renameTask(this.state, themeId, repoId, taskId, name)))
  }

  async setTaskNotes(themeId: string, repoId: string, taskId: string, notes: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.setTaskNotes(this.state, themeId, repoId, taskId, notes)))
  }

  /** Only the state queue: the move touches no worktree, so it doesn't wait for the task's git actions. */
  async moveTask(themeId: string, repoId: string, taskId: string, toIndex: number): Promise<AppState> {
    return this.exclusive(async () => this.commitIfChanged(m.moveTask(this.state, themeId, repoId, taskId, toIndex)))
  }

  async setTaskBudget(themeId: string, repoId: string, taskId: string, budgetUsd: number | null): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.setTaskBudget(this.state, themeId, repoId, taskId, budgetUsd)))
  }

  async checkTaskRemoval(themeId: string, repoId: string, taskId: string): Promise<UnsavedWork> {
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    return this.deps.git.getUnsavedWork(repo.path, task.worktreePath, task.branch, task.baseRef)
  }

  async removeTask(themeId: string, repoId: string, taskId: string, deleteBranch: boolean): Promise<AppState> {
    // After the task's queued git actions too, so a push never runs in a worktree being removed.
    return this.exclusive(() =>
      this.exclusive(() => this.removeTaskNow(themeId, repoId, taskId, deleteBranch), taskQueue(taskId)),
    )
  }

  private async removeTaskNow(
    themeId: string,
    repoId: string,
    taskId: string,
    deleteBranch: boolean,
  ): Promise<AppState> {
    const theme = m.getTheme(this.state, themeId)
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    this.detachIf((t) => t.taskId === taskId)
    // An archived task's session and worktree are gone already; whatever is at its path now isn't its own.
    if (!isArchived(task)) {
      await this.deps.tmux.killSession(sessionName(theme.slug, repo.slug, task.slug))
      // GitService deletes the folder directly when the original repo was moved or deleted.
      await this.deps.git.removeWorktree(repo.path, task.worktreePath)
    }
    // The branch lived in the original repo; if that is gone there is nothing to delete.
    if (deleteBranch && this.deps.pathExists(repo.path)) {
      await this.deps.git.deleteBranch(repo.path, task.branch).catch(() => {}) // may already be gone
    }
    return this.commit(m.removeTask(this.state, themeId, repoId, taskId))
  }

  /** Like removeTask, after the task's queued git actions, so nothing runs in a worktree being removed. */
  async archiveTask(themeId: string, repoId: string, taskId: string, force = false): Promise<AppState> {
    return this.exclusive(() =>
      this.exclusive(() => this.archiveTaskNow(themeId, repoId, taskId, force === true), taskQueue(taskId)),
    )
  }

  private async archiveTaskNow(themeId: string, repoId: string, taskId: string, force: boolean): Promise<AppState> {
    const { git, tmux } = this.deps
    const theme = m.getTheme(this.state, themeId)
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    if (isArchived(task)) throw new Error(`"${task.name}" is already archived`)
    // The branch lives in the original repo: without it there would be nothing to restore from.
    if (!this.deps.pathExists(repo.path)) {
      throw new Error(
        `The repository was not found at ${repo.path}, so the branch can't be kept: remove the task instead`,
      )
    }
    if (!force) {
      // Commits are safe on the kept branch; only what the worktree holds outside git would be lost.
      const work = await git.getUnsavedWork(repo.path, task.worktreePath, task.branch, task.baseRef)
      const n = work.uncommittedFiles.length
      if (n > 0) {
        throw new Error(
          `"${task.name}" has ${n} uncommitted or untracked ${n === 1 ? 'file' : 'files'}. ${ARCHIVE_REFUSAL}`,
        )
      }
      if (work.warning) throw new Error(`${work.warning} ${ARCHIVE_REFUSAL}`)
    }
    this.detachIf((t) => t.taskId === taskId)
    await tmux.killSession(sessionName(theme.slug, repo.slug, task.slug))
    // Prunes the worktree entry when its folder is already gone.
    await git.removeWorktree(repo.path, task.worktreePath)
    this.gitStatusCache.delete(task.worktreePath)
    return this.commit(m.archiveTask(this.state, themeId, repoId, taskId, new Date(this.now()).toISOString()))
  }

  /** On the task's queue too, like archiveTask. The session is started by the next openTarget, as for any task. */
  async unarchiveTask(themeId: string, repoId: string, taskId: string): Promise<AppState> {
    return this.exclusive(() => this.exclusive(() => this.unarchiveTaskNow(themeId, repoId, taskId), taskQueue(taskId)))
  }

  private async unarchiveTaskNow(themeId: string, repoId: string, taskId: string): Promise<AppState> {
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    const next = m.unarchiveTask(this.state, themeId, repoId, taskId) // throws if it isn't archived
    if (!this.deps.pathExists(repo.path)) throw new Error(`Repository not found: ${repo.path}`)
    if (this.deps.pathExists(task.worktreePath)) {
      throw new Error(`${task.worktreePath} is already taken; move it away, then restore the task`)
    }
    await this.deps.git.restoreWorktree(repo.path, task.worktreePath, task.branch)
    try {
      return await this.commit(next)
    } catch (err) {
      await this.deps.git.removeWorktree(repo.path, task.worktreePath).catch(() => {}) // still archived: no worktree
      throw err
    }
  }

  async openTarget(target: Target): Promise<TabInfo[]> {
    const seq = ++this.openSeq
    const { session, cwd, label } = this.resolve(target)
    if (!this.deps.pathExists(cwd)) throw new Error(`Folder not found: ${cwd}`)
    if (!(await this.deps.tmux.hasSession(session))) {
      await this.deps.tmux.newSession(session, cwd, CLAUDE_WINDOW, claudeContinueCommand(this.claudeArgs(label)))
    }
    // Latest wins: if the user opened something else meanwhile, attaching here would send
    // their keystrokes to a session the UI is not showing.
    if (seq !== this.openSeq) return this.deps.tmux.listWindows(session)
    const { file, args } = this.deps.tmux.attachCommand(session)
    this.deps.pty.attach(file, args, cwd)
    this.current = target
    return this.deps.tmux.listWindows(session)
  }

  /** Also cancels an open still in flight, so it won't attach afterwards. */
  async detachTerminal(): Promise<void> {
    this.openSeq++
    this.detachIf(() => true)
  }

  async listTabs(target: Target): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    return this.deps.tmux.listWindows(session).catch(() => [])
  }

  async newTab(target: Target): Promise<TabInfo[]> {
    const { session, cwd } = this.resolve(target)
    const names = new Set((await this.deps.tmux.listWindows(session)).map((t) => t.name))
    let name = 'shell'
    for (let n = 2; names.has(name); n++) name = `shell ${n}`
    await this.deps.tmux.newWindow(session, cwd, name)
    return this.deps.tmux.listWindows(session)
  }

  async selectTab(target: Target, index: number): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    await this.deps.tmux.selectWindow(session, index)
    return this.deps.tmux.listWindows(session)
  }

  async closeTab(target: Target, index: number): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    await this.deps.tmux.killWindow(session, index)
    return this.listTabs(target)
  }

  async restartClaude(target: Target): Promise<TabInfo[]> {
    const { session, cwd, label } = this.resolve(target)
    if (!(await this.deps.tmux.hasSession(session))) return this.openTarget(target)
    const existing = (await this.deps.tmux.listWindows(session)).find((t) => t.name === CLAUDE_WINDOW)
    if (existing) await this.deps.tmux.selectWindow(session, existing.index)
    else await this.deps.tmux.newWindow(session, cwd, CLAUDE_WINDOW, claudeContinueCommand(this.claudeArgs(label)))
    return this.deps.tmux.listWindows(session)
  }

  async leaveCopyMode(target: Target): Promise<void> {
    const { session } = this.resolve(target)
    await this.deps.tmux.leaveCopyMode(session)
  }

  // The run command, in a `run` tab of the target's session (see runWindowCommand). Each runs on the session's run
  // queue, against the state as it is when its turn comes.

  /** The target's session and folder (refusing an archived task, like resolve) and its item. */
  private runTarget(target: Target): { session: string; cwd: string; item: Item } {
    const { session, cwd } = this.resolve(target)
    return { session, cwd, item: m.getItem(this.state, target.themeId, target.itemId) }
  }

  /** Runs `op` on the target's run queue with its item's run command; refuses without one, or without a session. */
  private withRunCommand(
    target: Target,
    op: (run: { session: string; cwd: string; command: string; tabs: TabInfo[] }) => Promise<void>,
  ): Promise<TabInfo[]> {
    return this.exclusive(
      async () => {
        const { session, cwd, item } = this.runTarget(target)
        if (!item.runCommand) throw new Error(`Set a run command for “${item.name}” first`)
        if (!(await this.deps.tmux.hasSession(session))) {
          throw new Error(`Open the ${target.taskId ? 'task' : 'folder'} first: its session is not running`)
        }
        await op({ session, cwd, command: item.runCommand, tabs: await this.deps.tmux.listWindows(session) })
        return this.deps.tmux.listWindows(session)
      },
      runQueue(this.resolve(target).session),
    )
  }

  private newRunWindow(session: string, cwd: string, command: string): Promise<void> {
    return this.deps.tmux.newWindow(session, cwd, RUN_WINDOW, runWindowCommand(command), { remainOnExit: true })
  }

  /** Shows the run tab when there is one, running or stopped (Restart runs it again); otherwise opens one. */
  async startRun(target: Target): Promise<TabInfo[]> {
    return this.withRunCommand(target, async ({ session, cwd, command, tabs }) => {
      const run = tabs.find((t) => t.name === RUN_WINDOW)
      if (run) await this.deps.tmux.selectWindow(session, run.index)
      else await this.newRunWindow(session, cwd, command)
    })
  }

  /**
   * Runs the item's current command again in the run tab, and shows it: a running one gets Ctrl-C and
   * runGraceMs to shut down first, and is killed if it is still running then (`respawn-window -k`). Opens a run
   * tab when there is none.
   */
  async restartRun(target: Target): Promise<TabInfo[]> {
    return this.withRunCommand(target, async ({ session, cwd, command, tabs }) => {
      const { tmux } = this.deps
      let run = tabs.find((t) => t.name === RUN_WINDOW)
      if (run && !run.dead) {
        await tmux.sendInterrupt(session, RUN_WINDOW)
        if (this.runGraceMs > 0) await new Promise((r) => setTimeout(r, this.runGraceMs))
        // A run tab without remain-on-exit (made outside the app) closes when its command exits.
        run = (await tmux.listWindows(session)).find((t) => t.name === RUN_WINDOW)
      }
      if (!run) return this.newRunWindow(session, cwd, command)
      await tmux.respawnWindow(session, RUN_WINDOW, cwd, runWindowCommand(command))
      await tmux.selectWindow(session, run.index)
    })
  }

  /**
   * Ctrl-C in the run tab, which stays open with the output (its process may ignore it: closing the tab kills it).
   * Nothing to do for a stopped or missing one. Needs no run command: it may have been removed meanwhile.
   */
  async stopRun(target: Target): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    return this.exclusive(async () => {
      this.runTarget(target) // still there, and not archived meanwhile
      const run = (await this.deps.tmux.listWindows(session).catch(() => [] as TabInfo[])).find(
        (t) => t.name === RUN_WINDOW,
      )
      if (run && !run.dead) await this.deps.tmux.sendInterrupt(session, RUN_WINDOW)
      return this.deps.tmux.listWindows(session).catch(() => [])
    }, runQueue(session))
  }

  /**
   * Read-only, so it skips the queues. One `list-windows`, plus a capture of each tab that printed something since
   * its last one (see mayHaveChanged), at most every DEV_URL_RESCAN_MS. Closed tabs drop out with their URLs.
   */
  async getDevUrls(target: Target): Promise<DevUrl[]> {
    const { session } = this.resolve(target)
    const windows = await this.deps.tmux.listWindowActivity(session).catch(() => [])
    if (this.devUrlScans?.session !== session) this.devUrlScans = { session, tabs: new Map() }
    const scans = this.devUrlScans.tabs
    const live = new Set(windows.map((w) => w.id))
    for (const id of scans.keys()) if (!live.has(id)) scans.delete(id)
    const now = this.now()
    await mapLimit(windows, PANE_CAPTURE_CONCURRENCY, async ({ id, activity }) => {
      const scan = scans.get(id)
      if (scan && (!mayHaveChanged(scan, activity) || now - scan.at < DEV_URL_RESCAN_MS)) return
      const text = await this.deps.tmux.captureTail(id, DEV_URL_SCROLLBACK_LINES).catch(() => null)
      scans.set(id, { activity, at: now, urls: text === null ? [] : findDevUrls(text) })
    })
    const urls: DevUrl[] = []
    const seen = new Set<string>()
    // The tab that printed last first; sort is stable, so tabs that printed in the same second keep their order.
    for (const w of [...windows].sort((a, b) => b.activity - a.activity)) {
      for (const url of scans.get(w.id)?.urls ?? []) {
        if (seen.has(url)) continue
        seen.add(url)
        urls.push({ url, index: w.index, tab: w.name })
      }
    }
    return urls.slice(0, MAX_DEV_URLS)
  }

  // Transcripts. Read-only, so these skip the mutation queue.

  async copyTranscript(target: Target, index: number): Promise<Transcript> {
    return (await this.captureTranscript(target, index)).transcript
  }

  /**
   * The index comes from the renderer: it must be one of the session's windows, so tmux never resolves it some
   * other way. The file name uses the theme's and the task's (or folder's) slugs and the tab's name.
   */
  async captureTranscript(target: Target, index: number): Promise<CapturedTranscript> {
    const theme = m.getTheme(this.state, target.themeId)
    const item = m.getItem(this.state, target.themeId, target.itemId)
    const { session } = this.resolve(target)
    const tabs = Number.isInteger(index) ? await this.deps.tmux.listWindows(session).catch(() => [] as TabInfo[]) : []
    const tab = tabs.find((t) => t.index === index)
    if (!tab) throw new Error('That tab is no longer open')
    const { text, truncated } = await this.deps.tmux.captureHistory(session, index, MAX_TRANSCRIPT_BYTES)
    let lines = 0
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++
    const name =
      item.kind === 'repo' && target.taskId ? m.getTask(this.state, theme.id, item.id, target.taskId).slug : item.slug
    return {
      transcript: { text, lines, truncated },
      fileName: transcriptFileName({ theme: theme.slug, target: name, tab: tab.name }, new Date(this.now())),
    }
  }

  // Git actions on a task's worktree. Each runs on the task's own queue and refreshes its git status after.

  async getGitTools(): Promise<GitTools> {
    return { gh: this.deps.gh.available() }
  }

  /**
   * Runs `op` on the task's queue, against the task as it is when its turn comes (it may have been removed while
   * waiting), and drops its cached git status after, so the next poll reads it again.
   */
  private gitAction<T>(target: Target, op: (task: Task, repo: Repo) => Promise<T>): Promise<T> {
    const queue = taskQueue(this.resolveTaskTarget(target).task.id)
    return this.exclusive(async () => {
      const { task, repo } = this.resolveTaskTarget(target)
      if (!this.deps.pathExists(task.worktreePath)) throw new Error(`Folder not found: ${task.worktreePath}`)
      try {
        return await op(task, repo)
      } finally {
        this.gitStatusCache.delete(task.worktreePath)
      }
    }, queue)
  }

  /** A repo task's records; throws for folders, unknown targets and repos without a task. */
  private resolveTaskTarget(target: Target): { task: Task; repo: Repo } {
    const item = m.getItem(this.state, target.themeId, target.itemId)
    if (item.kind !== 'repo' || !target.taskId) throw new Error('Git actions are only available for repository tasks')
    const task = m.getTask(this.state, target.themeId, item.id, target.taskId)
    assertNotArchived(task)
    return { task, repo: item }
  }

  async commitAll(target: Target, message: string): Promise<CommitResult> {
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text) throw new Error('Write a commit message first')
    if (text.length > MAX_COMMIT_MESSAGE)
      throw new Error(`The commit message is limited to ${MAX_COMMIT_MESSAGE.toLocaleString('en-US')} characters`)
    if (text.includes('\0')) throw new Error('Invalid commit message')
    return this.gitAction(target, (task) => this.deps.git.commitAll(task.worktreePath, text))
  }

  async pushTask(target: Target): Promise<PushResult> {
    return this.gitAction(target, async (task) => {
      await this.deps.git.push(task.worktreePath, task.branch)
      return { branch: task.branch }
    })
  }

  async createPullRequest(target: Target): Promise<PullRequestResult> {
    return this.gitAction(target, (task) =>
      this.deps.gh.pullRequest(task.worktreePath, task.branch, baseBranchName(task.baseRef)),
    )
  }

  /** Fetch (giving up after the usual timeout), then rebase onto the base or merge it, per Settings. */
  async updateFromBase(target: Target): Promise<UpdateResult> {
    return this.gitAction(target, async (task, repo) => {
      await this.fetchWithTimeout(repo.path)
      return this.deps.git.updateFromBase(task.worktreePath, task.baseRef, this.deps.settings.get().updateStrategy)
    })
  }

  async askClaudeToResolve(target: Target, strategy: UpdateStrategy, files: string[]): Promise<TabInfo[]> {
    const { task } = this.resolveTaskTarget(target)
    const { session, cwd, label } = this.resolve(target)
    const text = resolvePrompt(strategy, task.baseRef, files)
    if (!(await this.deps.tmux.hasSession(session))) throw new Error('Open the task first: its session is not running')
    const claude = (await this.deps.tmux.listWindows(session)).find((t) => t.name === CLAUDE_WINDOW)
    if (claude) {
      await this.assertClaudeReady(session)
      await this.deps.tmux.sendText(session, CLAUDE_WINDOW, text)
      await this.deps.tmux.selectWindow(session, claude.index)
    } else {
      // Claude's window was closed: start it again, continuing its conversation, with the request as the prompt.
      const args = this.claudeArgs(label)
      await this.withPromptFile(text, (file) =>
        this.deps.tmux.newWindow(session, cwd, CLAUDE_WINDOW, claudeContinueCommand(args, file)),
      )
    }
    return this.deps.tmux.listWindows(session)
  }

  /**
   * Pastes without Enter: the user reads the comments in Claude's prompt and submits them. Unlike
   * askClaudeToResolve, a closed Claude tab is not started again, as nobody would be there to submit the text.
   */
  async sendToClaude(target: Target, text: string): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    const message = claudeMessage(text)
    if (!(await this.deps.tmux.hasSession(session))) {
      throw new Error(`Open the ${target.taskId ? 'task' : 'folder'} first: its session is not running`)
    }
    const claude = (await this.deps.tmux.listWindows(session)).find((t) => t.name === CLAUDE_WINDOW)
    if (!claude) throw new Error('There is no Claude tab — start one with “Restart Claude” first')
    await this.assertClaudeReady(session)
    await this.deps.tmux.sendText(session, CLAUDE_WINDOW, message, { enter: false })
    await this.deps.tmux.selectWindow(session, claude.index)
    return this.deps.tmux.listWindows(session)
  }

  /**
   * Refuses to type into a Claude that isn't at its prompt: the Enter after the text would pick the highlighted
   * option of a permission prompt or choice menu (and without Enter, the text would still land in that menu, not
   * in the prompt), and a busy Claude would only queue it behind its work.
   */
  private async assertClaudeReady(session: string): Promise<void> {
    const [pane, activity] = await Promise.all([
      this.deps.tmux.capturePane(session, CLAUDE_WINDOW),
      this.deps.tmux.windowActivity(CLAUDE_WINDOW).catch(() => ({}) as Record<string, number>),
    ])
    if (pane !== null && looksWaiting(pane)) throw new Error('Claude is waiting for input — answer it first')
    const activitySec = activity[session]
    if (activitySec !== undefined && isRecentlyActive(activitySec, this.now())) {
      throw new Error("Claude is busy — try again when it's idle")
    }
  }

  // File viewer. Read-only, so these skip the mutation queue.

  /** A target's folder (task worktree or folder path), whether or not it still exists. Throws for archived tasks. */
  private targetRoot(target: Target): { root: string; isRepo: boolean; baseRef?: string } {
    const item = m.getItem(this.state, target.themeId, target.itemId)
    if (item.kind === 'folder') return { root: item.path, isRepo: false }
    if (!target.taskId) throw new Error('Choose a task to open')
    const task = m.getTask(this.state, target.themeId, item.id, target.taskId)
    assertNotArchived(task)
    return { root: task.worktreePath, isRepo: true, baseRef: task.baseRef }
  }

  private tryTargetRoot(target: Target): { root: string; isRepo: boolean; baseRef?: string } | null {
    try {
      return this.targetRoot(target)
    } catch {
      return null
    }
  }

  /** The folder the file viewer shows for a target; throws if it is gone from disk. */
  private resolveRoot(target: Target): { root: string; isRepo: boolean; baseRef?: string } {
    const resolved = this.targetRoot(target)
    if (!this.deps.pathExists(resolved.root)) throw new Error(`Folder not found: ${resolved.root}`)
    return resolved
  }

  /** Like resolveRoot, but only for repo tasks, which have a base ref to diff against. */
  private resolveTask(target: Target): { root: string; baseRef: string } {
    const { root, baseRef } = this.resolveRoot(target)
    if (baseRef === undefined) throw new Error('Changes are only available for repository tasks')
    return { root, baseRef }
  }

  async listFiles(target: Target): Promise<FileList> {
    const { root, isRepo } = this.resolveRoot(target)
    return this.deps.files.listFiles(root, isRepo)
  }

  async readFile(target: Target, path: string): Promise<FileContent> {
    const { root } = this.resolveRoot(target)
    return this.deps.files.readFile(root, path)
  }

  async readImage(target: Target, path: string): Promise<string | null> {
    const { root } = this.resolveRoot(target)
    return this.deps.files.readImage(root, path)
  }

  /**
   * The query and options are checked by the files service. Only the latest search per target runs: one still
   * running there is cancelled (git killed, matching stopped) and rejects, as the renderer only shows the latest.
   */
  async searchFiles(target: Target, query: string, options?: SearchOptions): Promise<SearchResult> {
    const { root, isRepo } = this.resolveRoot(target)
    const key = targetKey(target)
    this.searches.get(key)?.abort()
    const controller = new AbortController()
    this.searches.set(key, controller)
    try {
      return await this.deps.files.searchFiles(root, isRepo, query, options, controller.signal)
    } finally {
      if (this.searches.get(key) === controller) this.searches.delete(key)
    }
  }

  async listChanges(target: Target, scope: ChangeScope = 'base'): Promise<ChangeList> {
    const { root, baseRef } = this.resolveTask(target)
    // Against HEAD, the merge-base is HEAD itself: what a commit would take.
    return this.deps.files.listChanges(root, scope === 'uncommitted' ? 'HEAD' : baseRef)
  }

  async fileDiff(target: Target, path: string, oldPath?: string): Promise<string> {
    const { root, baseRef } = this.resolveTask(target)
    return this.deps.files.fileDiff(root, baseRef, path, oldPath)
  }

  // External apps, on the same root the file viewer shows (a task's worktree or a folder), checked to exist.

  async openInEditor(target: Target): Promise<void> {
    const { root } = this.resolveRoot(target)
    await this.deps.launcher.openInEditor(root, this.deps.settings.get().editorCommand)
  }

  async openInFileManager(target: Target): Promise<void> {
    const { root } = this.resolveRoot(target)
    await this.deps.launcher.openInFileManager(root)
  }

  // Claude usage, from Claude Code's transcripts. Read-only, and it works for targets whose folder is gone too.

  /**
   * Every task and folder, in sidebar order, with the folder its usage is counted for. Archived tasks are in too:
   * only their transcripts are read, never their (gone) worktree, and their past cost still counts.
   */
  private usageTargets(): Omit<UsageTargetReport, 'usage'>[] {
    const targets: Omit<UsageTargetReport, 'usage'>[] = []
    for (const theme of this.state.themes) {
      for (const item of theme.items) {
        if (item.kind === 'folder') {
          targets.push({
            target: { themeId: theme.id, itemId: item.id },
            kind: 'folder',
            label: item.name,
            path: item.path,
          })
          continue
        }
        for (const task of item.tasks) {
          targets.push({
            target: { themeId: theme.id, itemId: item.id, taskId: task.id },
            kind: 'task',
            label: `${item.name} › ${task.name}${isArchived(task) ? ' (archived)' : ''}`,
            path: task.worktreePath,
          })
        }
      }
    }
    return targets
  }

  /**
   * Usage of every target and theme, and the total. getUsage asks for exactly this too, so the usage service's
   * cached aggregation serves both instead of each evicting the other's. Every known root is passed along, so a
   * message is counted for the most specific one only.
   */
  private async allUsage(): Promise<{ targets: Omit<UsageTargetReport, 'usage'>[]; usage: UsageSummaries }> {
    const targets = this.usageTargets()
    const groups: Record<string, string[]> = { total: targets.map((t) => t.path) }
    for (const theme of this.state.themes) groups[themeGroup(theme.id)] = []
    for (const t of targets) groups[themeGroup(t.target.themeId)].push(t.path)
    return { targets, usage: await this.deps.usage.summarize(groups.total, groups) }
  }

  async getUsage(target: Target): Promise<UsageSummary> {
    const { root } = this.targetRoot(target)
    const { usage } = await this.allUsage()
    return usage.roots[root] ?? emptyUsageSummary()
  }

  async getBudgets(): Promise<BudgetReport> {
    const settings = this.deps.settings.get()
    const budgeted: { task: Task; limit: number }[] = []
    for (const theme of this.state.themes)
      for (const item of theme.items) {
        if (item.kind !== 'repo') continue
        for (const task of item.tasks) {
          const limit = effectiveTaskBudget(task, settings)
          if (limit !== null && !isArchived(task)) budgeted.push({ task, limit })
        }
      }
    if (budgeted.length === 0 && settings.dailyBudgetUsd === null) return { daily: null, tasks: {} }
    const { usage } = await this.allUsage()
    const tasks: Record<string, BudgetStatus> = {}
    for (const { task, limit } of budgeted) {
      tasks[task.id] = budgetStatus(usage.roots[task.worktreePath]?.all.cost ?? 0, limit)!
    }
    return { daily: budgetStatus(usage.groups.total?.today.cost ?? 0, settings.dailyBudgetUsd), tasks }
  }

  async getUsageReport(): Promise<UsageReport> {
    const { targets, usage } = await this.allUsage()
    return {
      generatedAt: new Date().toISOString(),
      total: usage.groups.total ?? emptyUsageSummary(),
      themes: this.state.themes.map((theme) => ({
        themeId: theme.id,
        name: theme.name,
        usage: usage.groups[themeGroup(theme.id)] ?? emptyUsageSummary(),
        targets: targets
          .filter((t) => t.target.themeId === theme.id)
          .map((t) => ({ ...t, usage: usage.roots[t.path] ?? emptyUsageSummary() })),
      })),
    }
  }
}
