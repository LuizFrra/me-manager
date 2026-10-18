import { randomUUID } from 'node:crypto'
import type {
  AppState,
  ChangeList,
  FileContent,
  FileList,
  LiveStatus,
  TabInfo,
  Target,
  Task,
  UnsavedWork,
} from '../../shared/types'
import { branchName, sessionName } from '../../shared/naming'
import type { AppService, OrchestratorDeps } from '../contracts'
import { taskWorktreePath } from '../paths'
import * as m from '../store/mutations'

export const CLAUDE_CMD = 'claude'
/** `--continue` fails when there is no previous conversation; fall back to a fresh one. */
export const CLAUDE_CONTINUE_CMD = 'claude --continue || claude'
const CLAUDE_WINDOW = 'claude'
/** How long createTask waits for `git fetch` before branching from the last fetched refs. */
export const FETCH_TIMEOUT_MS = 20_000

export interface OrchestratorOptions {
  /** Overrides FETCH_TIMEOUT_MS (for tests). */
  fetchTimeoutMs?: number
}

export class Orchestrator implements AppService {
  private state: AppState = m.emptyState()
  private current: Target | null = null
  /** Tail of the mutation queue; always resolves, so a failure never blocks later calls. */
  private queue: Promise<void> = Promise.resolve()
  private readonly fetchTimeoutMs: number
  /** Bumped by every openTarget call, so only the latest one attaches the terminal. */
  private openSeq = 0

  constructor(
    private readonly deps: OrchestratorDeps,
    options: OrchestratorOptions = {},
  ) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
  }

  async init(): Promise<void> {
    this.state = await this.deps.store.load()
  }

  private async commit(next: AppState): Promise<AppState> {
    await this.deps.store.save(next)
    this.state = next
    return next
  }

  /**
   * Runs state-changing operations one at a time: FileStore.save is not safe to call
   * concurrently, and overlapping operations would read stale state (lost updates,
   * duplicate tasks passing the slug check).
   */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op)
    this.queue = run.then(
      () => {},
      () => {},
    )
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

  private resolve(target: Target): { session: string; cwd: string } {
    const theme = m.getTheme(this.state, target.themeId)
    const item = m.getItem(this.state, target.themeId, target.itemId)
    if (item.kind === 'folder') return { session: sessionName(theme.slug, item.slug), cwd: item.path }
    if (!target.taskId) throw new Error('Choose a task to open')
    const task = m.getTask(this.state, theme.id, item.id, target.taskId)
    return { session: sessionName(theme.slug, item.slug, task.slug), cwd: task.worktreePath }
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

  async getStatus(): Promise<LiveStatus> {
    const sessions = new Set(await this.deps.tmux.listSessions().catch(() => [] as string[]))
    const running: string[] = []
    const missing: string[] = []
    for (const theme of this.state.themes) {
      for (const item of theme.items) {
        if (!this.deps.pathExists(item.path)) missing.push(item.id)
        if (item.kind === 'folder') {
          if (sessions.has(sessionName(theme.slug, item.slug))) running.push(item.id)
          continue
        }
        for (const task of item.tasks) {
          if (!this.deps.pathExists(task.worktreePath)) missing.push(task.id)
          if (sessions.has(sessionName(theme.slug, item.slug, task.slug))) running.push(task.id)
        }
      }
    }
    return { running, missing }
  }

  async createTheme(name: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.addTheme(this.state, name)))
  }

  async renameTheme(themeId: string, name: string): Promise<AppState> {
    return this.exclusive(async () => this.commit(m.renameTheme(this.state, themeId, name)))
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

  async addRepo(themeId: string, path: string): Promise<AppState> {
    return this.exclusive(async () => {
      const root = await this.deps.git.repoRoot(path)
      if (!root) throw new Error(`Not a git repository: ${path}`)
      return this.commit(m.addRepo(this.state, themeId, root))
    })
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

  async createTask(themeId: string, repoId: string, name: string): Promise<AppState> {
    return this.exclusive(async () => {
      const { git, tmux } = this.deps
      const theme = m.getTheme(this.state, themeId)
      const repo = m.getRepo(this.state, themeId, repoId)
      const slug = m.requireSlug(name, 'Task')
      m.assertTaskSlugFree(repo, slug)
      m.assertTaskNameFree(repo, name)
      const branch = branchName(theme.slug, slug)
      const worktreePath = taskWorktreePath(theme.slug, repo.slug, slug, this.deps.worktreesRoot)
      const session = sessionName(theme.slug, repo.slug, slug)

      await this.fetchWithTimeout(repo.path)
      const baseRef = await git.resolveBaseRef(repo.path)
      await git.addWorktree(repo.path, worktreePath, branch, baseRef)
      try {
        await tmux.newSession(session, worktreePath, CLAUDE_WINDOW, CLAUDE_CMD)
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

  async checkTaskRemoval(themeId: string, repoId: string, taskId: string): Promise<UnsavedWork> {
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    return this.deps.git.getUnsavedWork(repo.path, task.worktreePath, task.branch, task.baseRef)
  }

  async removeTask(themeId: string, repoId: string, taskId: string, deleteBranch: boolean): Promise<AppState> {
    return this.exclusive(async () => {
      const theme = m.getTheme(this.state, themeId)
      const repo = m.getRepo(this.state, themeId, repoId)
      const task = m.getTask(this.state, themeId, repoId, taskId)
      this.detachIf((t) => t.taskId === taskId)
      await this.deps.tmux.killSession(sessionName(theme.slug, repo.slug, task.slug))
      // GitService deletes the folder directly when the original repo was moved or deleted.
      await this.deps.git.removeWorktree(repo.path, task.worktreePath)
      // The branch lived in the original repo; if that is gone there is nothing to delete.
      if (deleteBranch && this.deps.pathExists(repo.path)) {
        await this.deps.git.deleteBranch(repo.path, task.branch).catch(() => {}) // may already be gone
      }
      return this.commit(m.removeTask(this.state, themeId, repoId, taskId))
    })
  }

  async openTarget(target: Target): Promise<TabInfo[]> {
    const seq = ++this.openSeq
    const { session, cwd } = this.resolve(target)
    if (!this.deps.pathExists(cwd)) throw new Error(`Folder not found: ${cwd}`)
    if (!(await this.deps.tmux.hasSession(session))) {
      await this.deps.tmux.newSession(session, cwd, CLAUDE_WINDOW, CLAUDE_CONTINUE_CMD)
    }
    // Latest wins: if the user opened something else meanwhile, attaching here would send
    // their keystrokes to a session the UI is not showing.
    if (seq !== this.openSeq) return this.deps.tmux.listWindows(session)
    const { file, args } = this.deps.tmux.attachCommand(session)
    this.deps.pty.attach(file, args, cwd)
    this.current = target
    return this.deps.tmux.listWindows(session)
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
    const { session, cwd } = this.resolve(target)
    if (!(await this.deps.tmux.hasSession(session))) return this.openTarget(target)
    const existing = (await this.deps.tmux.listWindows(session)).find((t) => t.name === CLAUDE_WINDOW)
    if (existing) await this.deps.tmux.selectWindow(session, existing.index)
    else await this.deps.tmux.newWindow(session, cwd, CLAUDE_WINDOW, CLAUDE_CONTINUE_CMD)
    return this.deps.tmux.listWindows(session)
  }

  // File viewer. Read-only, so these skip the mutation queue.

  /** The folder the file viewer shows for a target; throws if it is gone from disk. */
  private resolveRoot(target: Target): { root: string; isRepo: boolean; baseRef?: string } {
    const item = m.getItem(this.state, target.themeId, target.itemId)
    let resolved: { root: string; isRepo: boolean; baseRef?: string }
    if (item.kind === 'folder') {
      resolved = { root: item.path, isRepo: false }
    } else {
      if (!target.taskId) throw new Error('Choose a task to open')
      const task = m.getTask(this.state, target.themeId, item.id, target.taskId)
      resolved = { root: task.worktreePath, isRepo: true, baseRef: task.baseRef }
    }
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

  async listChanges(target: Target): Promise<ChangeList> {
    const { root, baseRef } = this.resolveTask(target)
    return this.deps.files.listChanges(root, baseRef)
  }

  async fileDiff(target: Target, path: string, oldPath?: string): Promise<string> {
    const { root, baseRef } = this.resolveTask(target)
    return this.deps.files.fileDiff(root, baseRef, path, oldPath)
  }
}
