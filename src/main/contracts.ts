import type { AppState, MeManagerApi, TabInfo, UnsavedWork } from '../shared/types'

export interface StoreApi {
  load(): Promise<AppState>
  save(state: AppState): Promise<void>
}

export interface GitApi {
  /** Top-level directory of the repo containing `path`, or null if not a repo. */
  repoRoot(path: string): Promise<string | null>
  /** `git fetch origin --prune`; no-op when there is no origin remote. */
  fetch(repoPath: string): Promise<void>
  /** e.g. "origin/main"; falls back to local main/master/current branch. */
  resolveBaseRef(repoPath: string): Promise<string>
  addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void>
  /** Removes the worktree (forced); prunes if its folder is already gone. */
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>
  deleteBranch(repoPath: string, branch: string): Promise<void>
  getUnsavedWork(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<UnsavedWork>
}

export interface TmuxApi {
  hasSession(name: string): Promise<boolean>
  /** Session names on our socket; [] when the tmux server is not running. */
  listSessions(): Promise<string[]>
  /** Detached session whose first window runs `command` (a shell string). */
  newSession(name: string, cwd: string, windowName: string, command: string): Promise<void>
  /** No-op if the session does not exist. */
  killSession(name: string): Promise<void>
  listWindows(session: string): Promise<TabInfo[]>
  /** New window that becomes active; runs the default shell when command is omitted. */
  newWindow(session: string, cwd: string, windowName: string, command?: string): Promise<void>
  selectWindow(session: string, index: number): Promise<void>
  killWindow(session: string, index: number): Promise<void>
  attachCommand(session: string): { file: string; args: string[] }
}

export interface PtyApi {
  /** Spawns file/args in a pty, replacing (killing) any previous one. */
  attach(file: string, args: string[], cwd: string): void
  /** Kills the current pty without emitting exit. */
  detach(): void
  write(data: string): void
  /** Remembers the size and resizes the current pty, if any. */
  resize(cols: number, rows: number): void
  onData(cb: (data: string) => void): () => void
  onExit(cb: (code: number) => void): () => void
}

/** What the orchestrator implements: everything except renderer/pty-only calls. */
export type AppService = Omit<
  MeManagerApi,
  'checkPrereqs' | 'pickDirectory' | 'ptyWrite' | 'ptyResize' | 'onPtyData' | 'onPtyExit'
>

export interface OrchestratorDeps {
  store: StoreApi
  git: GitApi
  tmux: TmuxApi
  pty: PtyApi
  worktreesRoot: string
  pathExists: (path: string) => boolean
}
