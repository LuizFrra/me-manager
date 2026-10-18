import type {
  AppState,
  ChangeList,
  CommitResult,
  PullRequestResult,
  FileContent,
  FileList,
  SearchOptions,
  SearchResult,
  TabInfo,
  TaskGitStatus,
  UnsavedWork,
  UiState,
  UpdateResult,
  UpdateStrategy,
  UsageSummary,
} from '../../shared/types'
import type {
  FilesApi,
  GhApi,
  GitApi,
  LauncherApi,
  OrchestratorDeps,
  PromptFilesApi,
  PtyApi,
  StoreApi,
  TmuxApi,
  UsageApi,
  UsageSummaries,
} from '../contracts'
import { GH_INSTALL_HINT } from '../../shared/git'
import { emptyUsageSummary } from '../../shared/usage'
import { emptyState } from '../store/mutations'
import { SettingsService, type SettingsStoreApi } from '../store/settings'
import type { UiStateStoreApi } from '../store/uiState'
import type { Settings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/settings'

export class MemoryStore implements StoreApi {
  saved: AppState[] = []
  constructor(private state: AppState = emptyState()) {}
  async load(): Promise<AppState> {
    return this.state
  }
  async save(state: AppState): Promise<void> {
    this.state = state
    this.saved.push(state)
  }
}

/** Tests start with the built-in Claude flags off, so command assertions only show what each test enables. */
export const TEST_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  claudeArgs: [],
  remoteControl: false,
  skipPermissions: false,
}

/** UI state in memory; `stored` is what load() returns, unchecked like a file's contents. */
export class MemoryUiStore implements UiStateStoreApi {
  saved: UiState[] = []
  constructor(public stored: unknown = { version: 1, collapsed: [], panels: {} }) {}
  async load(): Promise<unknown> {
    return this.stored
  }
  async save(state: UiState): Promise<void> {
    this.stored = state
    this.saved.push(state)
  }
}

export class MemorySettingsStore implements SettingsStoreApi {
  saved: Settings[] = []
  constructor(private settings: Settings = TEST_SETTINGS) {}
  async load(): Promise<Settings> {
    return this.settings
  }
  async save(settings: Settings): Promise<void> {
    this.settings = settings
    this.saved.push(settings)
  }
}

export class FakeGit implements GitApi {
  calls: string[] = []
  unsaved: UnsavedWork = { uncommittedFiles: [], unpushedCommits: [] }
  roots = new Map<string, string>()
  failFetch = false
  async repoRoot(path: string): Promise<string | null> {
    return this.roots.get(path) ?? null
  }
  async fetch(repo: string): Promise<void> {
    this.calls.push(`fetch ${repo}`)
    if (this.failFetch) throw new Error('offline')
  }
  async resolveBaseRef(): Promise<string> {
    return 'origin/main'
  }
  /** What listBranches returns; verifyRef is true for these unless listed in `unresolvable`. */
  branches = ['origin/develop', 'origin/main', 'main']
  unresolvable = new Set<string>()
  async listBranches(repo: string): Promise<string[]> {
    this.calls.push(`listBranches ${repo}`)
    return [...this.branches]
  }
  async verifyRef(_repo: string, ref: string): Promise<boolean> {
    return !ref.startsWith('-') && this.branches.includes(ref) && !this.unresolvable.has(ref)
  }
  /** When set, clone rejects with it. */
  failClone: string | null = null
  /** When set, clone waits for it, so tests can hold a clone in flight. */
  cloneGate: Promise<void> | null = null
  async clone(url: string, dest: string): Promise<void> {
    this.calls.push(`clone ${url} ${dest}`)
    if (this.cloneGate) await this.cloneGate
    if (this.failClone) throw new Error(this.failClone)
    this.roots.set(dest, dest)
  }
  async addWorktree(_repo: string, wt: string, branch: string, base: string): Promise<void> {
    this.calls.push(`addWorktree ${wt} ${branch} ${base}`)
  }
  async removeWorktree(_repo: string, wt: string): Promise<void> {
    this.calls.push(`removeWorktree ${wt}`)
  }
  async deleteBranch(_repo: string, branch: string): Promise<void> {
    this.calls.push(`deleteBranch ${branch}`)
  }
  async getUnsavedWork(): Promise<UnsavedWork> {
    return this.unsaved
  }
  /** By worktree path; a path without an entry rejects, like a folder that isn't a work tree. */
  statuses = new Map<string, TaskGitStatus>()
  statusCalls: string[] = []
  /** When set, taskStatus waits for it, so tests can hold calls in flight. */
  statusGate: Promise<void> | null = null
  inFlightStatus = 0
  peakInFlightStatus = 0
  /** When set, commitAll/push reject with it. */
  failAction: string | null = null
  /** When set, commitAll/push wait for it, so tests can hold them in flight. */
  actionGate: Promise<void> | null = null
  async commitAll(worktreePath: string, message: string): Promise<CommitResult> {
    this.calls.push(`commitAll ${worktreePath} ${JSON.stringify(message)}`)
    if (this.actionGate) await this.actionGate
    if (this.failAction) throw new Error(this.failAction)
    return { sha: 'abc1234', files: 3 }
  }
  async push(worktreePath: string, branch: string): Promise<void> {
    this.calls.push(`push ${worktreePath} ${branch}`)
    if (this.actionGate) await this.actionGate
    if (this.failAction) throw new Error(this.failAction)
  }
  /** What updateFromBase resolves with (its baseRef and strategy filled in from the call). */
  update: { kind: 'upToDate' } | { kind: 'updated'; commits: number } | { kind: 'conflict'; files: string[] } = {
    kind: 'updated',
    commits: 2,
  }
  async updateFromBase(worktreePath: string, baseRef: string, strategy: UpdateStrategy): Promise<UpdateResult> {
    this.calls.push(`updateFromBase ${worktreePath} ${baseRef} ${strategy}`)
    if (this.actionGate) await this.actionGate
    if (this.failAction) throw new Error(this.failAction)
    const u = this.update
    if (u.kind === 'upToDate') return { kind: 'upToDate', baseRef }
    if (u.kind === 'updated') return { kind: 'updated', strategy, baseRef, commits: u.commits }
    return { kind: 'conflict', strategy, baseRef, files: [...u.files] }
  }
  async taskStatus(worktreePath: string, baseRef: string): Promise<TaskGitStatus> {
    this.statusCalls.push(`${worktreePath} ${baseRef}`)
    this.peakInFlightStatus = Math.max(this.peakInFlightStatus, ++this.inFlightStatus)
    try {
      if (this.statusGate) await this.statusGate
      const status = this.statuses.get(worktreePath)
      if (!status) throw new Error(`not a work tree: ${worktreePath}`)
      return status
    } finally {
      this.inFlightStatus--
    }
  }
}

export class FakeGh implements GhApi {
  installed = true
  calls: string[] = []
  /** What pullRequest resolves with; set `fail` to reject instead. */
  result: PullRequestResult = { url: 'https://github.com/acme/my-api/pull/7', created: true }
  fail: string | null = null
  available(): boolean {
    return this.installed
  }
  async pullRequest(worktreePath: string, branch: string, baseBranch: string): Promise<PullRequestResult> {
    this.calls.push(`pullRequest ${worktreePath} ${branch} ${baseBranch}`)
    if (!this.installed) throw new Error(GH_INSTALL_HINT)
    if (this.fail) throw new Error(this.fail)
    return this.result
  }
}

export class FakeTmux implements TmuxApi {
  sessions = new Map<string, { cwd: string; windows: { name: string; command?: string }[]; active: number }>()
  calls: string[] = []
  failNewSession = false
  async hasSession(name: string): Promise<boolean> {
    return this.sessions.has(name)
  }
  async listSessions(): Promise<string[]> {
    return [...this.sessions.keys()]
  }
  async newSession(name: string, cwd: string, windowName: string, command: string): Promise<void> {
    this.calls.push(`newSession ${name} ${command}`)
    if (this.failNewSession) throw new Error('tmux failed')
    this.sessions.set(name, { cwd, windows: [{ name: windowName, command }], active: 0 })
  }
  async killSession(name: string): Promise<void> {
    this.calls.push(`killSession ${name}`)
    this.sessions.delete(name)
  }
  async listWindows(session: string): Promise<TabInfo[]> {
    const s = this.sessions.get(session)
    if (!s) throw new Error(`no session ${session}`)
    return s.windows.map((w, index) => ({ index, name: w.name, active: index === s.active }))
  }
  async newWindow(session: string, _cwd: string, windowName: string, command?: string): Promise<void> {
    const s = this.sessions.get(session)!
    s.windows.push({ name: windowName, command })
    s.active = s.windows.length - 1
  }
  async selectWindow(session: string, index: number): Promise<void> {
    this.sessions.get(session)!.active = index
  }
  async killWindow(session: string, index: number): Promise<void> {
    const s = this.sessions.get(session)!
    s.windows.splice(index, 1)
    s.active = 0
    if (s.windows.length === 0) this.sessions.delete(session)
  }
  attachCommand(session: string): { file: string; args: string[] } {
    return { file: 'tmux', args: ['attach', session] }
  }
  /** `window_activity` of each session's claude window (Unix seconds); sessions without one are left out. */
  activity = new Map<string, number>()
  /** Screen text by session, for capturePane. */
  panes = new Map<string, string>()
  captureCalls: string[] = []
  async windowActivity(windowName: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const [session, at] of this.activity) {
      if (this.sessions.get(session)?.windows.some((w) => w.name === windowName)) out[session] = at
    }
    return out
  }
  sent: string[] = []
  async sendText(session: string, windowName: string, text: string): Promise<void> {
    if (!this.sessions.get(session)?.windows.some((w) => w.name === windowName)) throw new Error("can't find window")
    this.sent.push(`${session}:${windowName} ${text}`)
  }
  async capturePane(session: string, windowName: string): Promise<string | null> {
    this.captureCalls.push(`${session}:${windowName}`)
    return this.panes.get(session) ?? null
  }
}

export class FakePty implements PtyApi {
  attached: { file: string; args: string[]; cwd: string } | null = null
  detached = 0
  attach(file: string, args: string[], cwd: string): void {
    this.attached = { file, args, cwd }
  }
  detach(): void {
    this.attached = null
    this.detached++
  }
  write(): void {
    // no-op
  }
  resize(): void {
    // no-op
  }
  onData(): () => void {
    return () => {}
  }
  onExit(): () => void {
    return () => {}
  }
}

export class FakeFiles implements FilesApi {
  calls: string[] = []
  async listFiles(root: string, isRepo: boolean): Promise<FileList> {
    this.calls.push(`listFiles ${root} ${isRepo}`)
    return { paths: [], truncated: false }
  }
  async readFile(root: string, relPath: string): Promise<FileContent> {
    this.calls.push(`readFile ${root} ${relPath}`)
    return { kind: 'missing' }
  }
  async readImage(root: string, relPath: string): Promise<string | null> {
    this.calls.push(`readImage ${root} ${relPath}`)
    return null
  }
  async searchFiles(root: string, isRepo: boolean, query: string, options?: SearchOptions): Promise<SearchResult> {
    this.calls.push(`searchFiles ${root} ${isRepo} ${JSON.stringify(query)} ${JSON.stringify(options ?? {})}`)
    return { matches: [], truncated: false }
  }
  async listChanges(worktree: string, baseRef: string): Promise<ChangeList> {
    this.calls.push(`listChanges ${worktree} ${baseRef}`)
    return { files: [] }
  }
  async fileDiff(worktree: string, baseRef: string, relPath: string, oldPath?: string): Promise<string> {
    this.calls.push(`fileDiff ${worktree} ${baseRef} ${relPath}${oldPath === undefined ? '' : ` (from ${oldPath})`}`)
    return ''
  }
}

export class FakeLauncher implements LauncherApi {
  calls: string[] = []
  fail: string | null = null
  async openInEditor(path: string, editorCommand: string): Promise<void> {
    this.calls.push(`editor ${path} [${editorCommand}]`)
    if (this.fail) throw new Error(this.fail)
  }
  async openInFileManager(path: string): Promise<void> {
    this.calls.push(`fileManager ${path}`)
    if (this.fail) throw new Error(this.fail)
  }
}

/** Prompt files in memory: `files` holds what is written and not yet released, `written` everything, by path. */
export class FakePromptFiles implements PromptFilesApi {
  files = new Map<string, string>()
  written = new Map<string, string>()
  calls: string[] = []
  private n = 0
  /** When set, write rejects with it. */
  failWrite: string | null = null
  async write(text: string): Promise<string> {
    if (this.failWrite) throw new Error(this.failWrite)
    const path = `/prompts/prompt-${++this.n}.txt`
    this.files.set(path, text)
    this.written.set(path, text)
    this.calls.push(`write ${path}`)
    return path
  }
  release(path: string, immediately = false): void {
    this.calls.push(`release ${path}${immediately ? ' now' : ''}`)
    this.files.delete(path)
  }
}

/** Returns `byRoot[root]` for each root and `byGroup[name]` for each group (empty usage otherwise). */
export class FakeUsage implements UsageApi {
  calls: { roots: string[]; groups: Record<string, string[]> }[] = []
  byRoot: Record<string, UsageSummary> = {}
  byGroup: Record<string, UsageSummary> = {}
  async summarize(
    roots: readonly string[],
    groups: Readonly<Record<string, readonly string[]>> = {},
  ): Promise<UsageSummaries> {
    this.calls.push({
      roots: [...roots],
      groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]])),
    })
    return {
      roots: Object.fromEntries(roots.map((r) => [r, this.byRoot[r] ?? emptyUsageSummary()])),
      groups: Object.fromEntries(Object.keys(groups).map((g) => [g, this.byGroup[g] ?? emptyUsageSummary()])),
    }
  }
}

export function makeDeps(overrides: Partial<OrchestratorDeps> = {}): {
  deps: OrchestratorDeps
  store: MemoryStore
  git: FakeGit
  gh: FakeGh
  tmux: FakeTmux
  pty: FakePty
  files: FakeFiles
  settings: SettingsService
  ui: MemoryUiStore
  launcher: FakeLauncher
  usage: FakeUsage
  promptFiles: FakePromptFiles
} {
  const store = new MemoryStore()
  const git = new FakeGit()
  const gh = new FakeGh()
  const tmux = new FakeTmux()
  const pty = new FakePty()
  const files = new FakeFiles()
  const settings = new SettingsService(new MemorySettingsStore(), TEST_SETTINGS)
  const launcher = new FakeLauncher()
  const usage = new FakeUsage()
  const ui = new MemoryUiStore()
  const promptFiles = new FakePromptFiles()
  const deps: OrchestratorDeps = {
    store,
    git,
    gh,
    tmux,
    pty,
    files,
    settings,
    ui,
    launcher,
    usage,
    promptFiles,
    worktreesRoot: '/wt',
    pathExists: () => true,
    ...overrides,
  }
  return { deps, store, git, gh, tmux, pty, files, settings, ui, launcher, usage, promptFiles }
}
