import type { UiStateStoreApi } from './store/uiState'
import type {
  AppState,
  ChangeList,
  CommitResult,
  FileContent,
  FileList,
  MeManagerApi,
  PullRequestResult,
  SearchOptions,
  SearchResult,
  Settings,
  TabInfo,
  TaskGitStatus,
  UnsavedWork,
  UpdateResult,
  UpdateStrategy,
  UsageSummary,
} from '../shared/types'

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
  /**
   * origin's branches as `origin/<name>` (without `origin/HEAD`), then the local branches, each sorted by name.
   * Read-only: no fetch.
   */
  listBranches(repoPath: string): Promise<string[]>
  /** Whether `ref` names a commit in the repo (`rev-parse --verify`); false for anything starting with '-'. */
  verifyRef(repoPath: string, ref: string): Promise<boolean>
  /**
   * `git clone -- <url> <dest>`, non-interactive, with the ext and fd transports off, giving up after
   * CLONE_TIMEOUT_MS. The URL is checked with checkCloneUrl. `dest` (absolute) is created here first, so one that
   * exists is refused; when the clone fails, `dest` (which this call created) is removed again.
   */
  clone(url: string, dest: string): Promise<void>
  addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void>
  /** Removes the worktree (forced); prunes if its folder is already gone. */
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>
  deleteBranch(repoPath: string, branch: string): Promise<void>
  getUnsavedWork(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<UnsavedWork>
  /**
   * Ahead/behind counts against `baseRef`, the uncommitted file count, the checked-out branch and the last commit
   * of a task worktree. Read-only (`--no-optional-locks`); a missing or unsafe base ref sets `baseMissing`.
   * Rejects when the worktree is not a git work tree.
   */
  taskStatus(worktreePath: string, baseRef: string): Promise<TaskGitStatus>
  /**
   * `git add -A`, then `git commit -m <message>` with `user.useConfigOnly`, so a missing identity fails with
   * git's message instead of a guessed one. Rejects with "Nothing to commit" when nothing is staged.
   */
  commitAll(worktreePath: string, message: string): Promise<CommitResult>
  /** `git push -u origin <branch>`, non-interactive, giving up after a timeout. */
  push(worktreePath: string, branch: string): Promise<void>
  /**
   * `git rebase <baseRef>` or `git merge --no-edit <baseRef>` in the worktree (no fetch). Refuses when tracked
   * files have uncommitted changes or a rebase/merge is already in progress. On conflicts, collects the unmerged
   * files, aborts (leaving the branch and worktree as they were) and resolves with them.
   */
  updateFromBase(worktreePath: string, baseRef: string, strategy: UpdateStrategy): Promise<UpdateResult>
}

/** The GitHub CLI. Never through a shell. */
export interface GhApi {
  /** Whether `gh` is on PATH; looked up once. */
  available(): boolean
  /**
   * `gh pr create --fill --head <branch> --base <baseBranch>` in the worktree, unless the branch already has a
   * pull request, then the pull request's URL from `gh pr view`.
   */
  pullRequest(worktreePath: string, branch: string, baseBranch: string): Promise<PullRequestResult>
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
  /**
   * `#{window_activity}` (the last time it printed anything, in Unix seconds) of the window named `windowName` in
   * every session on our socket, by session name, from one `list-windows -a` call. {} when the server isn't running.
   */
  windowActivity(windowName: string): Promise<Record<string, number>>
  /** The visible text of a window's active pane (`capture-pane -p`), or null when there is no such window. */
  capturePane(session: string, windowName: string): Promise<string | null>
  /**
   * Pastes `text` literally into a window's active pane (through a tmux paste buffer, so any length works), then
   * presses Enter.
   */
  sendText(session: string, windowName: string, text: string): Promise<void>
}

/** Private files that hand a long prompt to a command tmux starts (see PromptFiles). */
export interface PromptFilesApi {
  /** Writes `text` to a new private file (mode 0600) and returns its absolute path. */
  write(text: string): Promise<string>
  /**
   * Deletes the file once the command reading it had time to start, or right away with `immediately` (when the
   * command never started).
   */
  release(path: string, immediately?: boolean): void
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

export interface FilesApi {
  /**
   * Relative paths (POSIX separators), sorted. Repos: tracked + untracked-not-ignored. Folders: walk minus
   * .git/node_modules. Stops at a cap and sets `truncated`.
   */
  listFiles(root: string, isRepo: boolean): Promise<FileList>
  readFile(root: string, relPath: string): Promise<FileContent>
  readImage(root: string, relPath: string): Promise<string | null>
  /**
   * Content search (see MeManagerApi.searchFiles). Repos: `git grep` over tracked and untracked-not-ignored files.
   * Folders: the listFiles walk, matched in JavaScript. `query` and `options` are checked here. When `signal`
   * aborts, git is killed and the matching stopped, and the search rejects.
   */
  searchFiles(
    root: string,
    isRepo: boolean,
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchResult>
  listChanges(worktree: string, baseRef: string): Promise<ChangeList>
  /** `oldPath`: the rename source from the change list, so the rename doesn't have to be looked up again. */
  fileDiff(worktree: string, baseRef: string, relPath: string, oldPath?: string): Promise<string>
}

export interface SettingsApi {
  /** The current settings (loaded at startup). */
  get(): Settings
  /** Normalizes the merged settings, saves them and returns them. */
  update(patch: Partial<Settings>): Promise<Settings>
}

/** Starts external apps on a folder. Never through a shell. */
export interface LauncherApi {
  /** `editorCommand` is Settings.editorCommand; '' auto-detects an editor. */
  openInEditor(path: string, editorCommand: string): Promise<void>
  openInFileManager(path: string): Promise<void>
}

export interface UsageSummaries {
  /** By root, exactly as passed in. */
  roots: Record<string, UsageSummary>
  /** By group name. */
  groups: Record<string, UsageSummary>
}

/** Claude Code usage from its transcripts. Read-only: never writes to the Claude config folder. */
export interface UsageApi {
  /**
   * Usage per root (a task worktree or folder path) and per named group of roots. A message counts for the most
   * specific root (requested directly or through a group) whose path contains its working directory; pass every
   * known root so a task inside a folder isn't also counted for the folder.
   */
  summarize(roots: readonly string[], groups?: Readonly<Record<string, readonly string[]>>): Promise<UsageSummaries>
}

/** What the orchestrator implements: everything except renderer/pty-only calls. */
export type AppService = Omit<
  MeManagerApi,
  | 'checkPrereqs'
  | 'getTmuxSocket'
  | 'pickDirectory'
  | 'ptyWrite'
  | 'ptyResize'
  | 'onPtyData'
  | 'onPtyExit'
  | 'onSelectTarget'
  | 'openExternal'
>

export interface OrchestratorDeps {
  store: StoreApi
  git: GitApi
  gh: GhApi
  tmux: TmuxApi
  pty: PtyApi
  files: FilesApi
  settings: SettingsApi
  /** ui-state.json (see MeManagerApi.getUiState). */
  ui: UiStateStoreApi
  launcher: LauncherApi
  usage: UsageApi
  promptFiles: PromptFilesApi
  worktreesRoot: string
  pathExists: (path: string) => boolean
}
