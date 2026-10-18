import type { AppState, ChangeList, FileContent, FileList, TabInfo, UnsavedWork } from '../../shared/types'
import type { FilesApi, GitApi, OrchestratorDeps, PtyApi, StoreApi, TmuxApi } from '../contracts'
import { emptyState } from '../store/mutations'
import { SettingsService, type SettingsStoreApi } from '../store/settings'
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

export class MemorySettingsStore implements SettingsStoreApi {
  saved: Settings[] = []
  constructor(private settings: Settings = { ...DEFAULT_SETTINGS, claudeArgs: [] }) {}
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
  async listChanges(worktree: string, baseRef: string): Promise<ChangeList> {
    this.calls.push(`listChanges ${worktree} ${baseRef}`)
    return { files: [] }
  }
  async fileDiff(worktree: string, baseRef: string, relPath: string, oldPath?: string): Promise<string> {
    this.calls.push(`fileDiff ${worktree} ${baseRef} ${relPath}${oldPath === undefined ? '' : ` (from ${oldPath})`}`)
    return ''
  }
}

export function makeDeps(overrides: Partial<OrchestratorDeps> = {}): {
  deps: OrchestratorDeps
  store: MemoryStore
  git: FakeGit
  tmux: FakeTmux
  pty: FakePty
  files: FakeFiles
  settings: SettingsService
} {
  const store = new MemoryStore()
  const git = new FakeGit()
  const tmux = new FakeTmux()
  const pty = new FakePty()
  const files = new FakeFiles()
  const settings = new SettingsService(new MemorySettingsStore())
  const deps: OrchestratorDeps = {
    store,
    git,
    tmux,
    pty,
    files,
    settings,
    worktreesRoot: '/wt',
    pathExists: () => true,
    ...overrides,
  }
  return { deps, store, git, tmux, pty, files, settings }
}
