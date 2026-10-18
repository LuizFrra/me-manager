export interface Task {
  id: string
  name: string
  slug: string
  branch: string
  worktreePath: string
  baseRef: string
  createdAt: string
  /** Free-text notes about the task, at most MAX_TASK_NOTES characters; absent when there are none. */
  notes?: string
}

export const MAX_TASK_NOTES = 2000

export interface Repo {
  id: string
  kind: 'repo'
  name: string
  slug: string
  path: string
  tasks: Task[]
}

export interface Folder {
  id: string
  kind: 'folder'
  name: string
  slug: string
  path: string
}

export type Item = Repo | Folder

export interface Theme {
  id: string
  name: string
  slug: string
  items: Item[]
}

export interface AppState {
  version: 1
  themes: Theme[]
}

/** What a terminal is attached to: a folder (no taskId) or a repo task. */
export interface Target {
  themeId: string
  itemId: string
  taskId?: string
}

/** Ids (task ids for tasks, item ids for folders/repos). */
export interface LiveStatus {
  running: string[]
  missing: string[]
}

export interface TabInfo {
  index: number
  name: string
  active: boolean
}

export interface UnsavedWork {
  uncommittedFiles: string[]
  unpushedCommits: string[]
  /** Set when the check could not run fully (e.g. the original repo was moved or deleted). */
  warning?: string
}

export interface PrereqResult {
  ok: boolean
  missing: { tool: string; hint: string }[]
}

/** App preferences, kept in settings.json next to state.json. See normalizeSettings for the rules. */
export interface Settings {
  /** Extra arguments for every `claude` the app starts, e.g. ['--model', 'opus']. */
  claudeArgs: string[]
  /** The editor to open tasks in, as a command line (the path is appended); '' auto-detects one. */
  editorCommand: string
  /** How often the sidebar status and the side panel refresh, in ms. */
  pollIntervalMs: number
  terminalFontSize: number
  /** Desktop notifications (used by a later feature). */
  /** Start every Claude session with Remote Control on, named `<theme>/<repo>/<task>` (`--remote-control`). */
  remoteControl: boolean
  /** Start every Claude session with `--dangerously-skip-permissions`: Claude runs commands without asking. */
  skipPermissions: boolean
  notifications: boolean
}

export function hasUnsavedWork(work: UnsavedWork): boolean {
  return work.uncommittedFiles.length > 0 || work.unpushedCommits.length > 0 || Boolean(work.warning)
}

/** The API the renderer sees as `window.api`. */
export interface MeManagerApi {
  getState(): Promise<AppState>
  getStatus(): Promise<LiveStatus>
  checkPrereqs(): Promise<PrereqResult>
  /** The `tmux -L` socket name the app's sessions live on, for "copy attach command". */
  getTmuxSocket(): Promise<string>

  getSettings(): Promise<Settings>
  /** Merges the patch into the settings, normalized (see normalizeSettings), saves and returns the result. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>

  createTheme(name: string): Promise<AppState>
  /** Display name only; the slug (and so branches, worktree paths and sessions) never changes. */
  renameTheme(themeId: string, name: string): Promise<AppState>
  removeTheme(themeId: string): Promise<AppState>

  pickDirectory(): Promise<string | null>
  addRepo(themeId: string, path: string): Promise<AppState>
  addFolder(themeId: string, path: string): Promise<AppState>
  removeItem(themeId: string, itemId: string): Promise<AppState>

  createTask(themeId: string, repoId: string, name: string): Promise<AppState>
  /** Display name only; the slug, branch, worktree path and tmux session never change. */
  renameTask(themeId: string, repoId: string, taskId: string, name: string): Promise<AppState>
  /** Up to MAX_TASK_NOTES characters; an empty string removes the notes. */
  setTaskNotes(themeId: string, repoId: string, taskId: string, notes: string): Promise<AppState>
  checkTaskRemoval(themeId: string, repoId: string, taskId: string): Promise<UnsavedWork>
  removeTask(themeId: string, repoId: string, taskId: string, deleteBranch: boolean): Promise<AppState>

  openTarget(target: Target): Promise<TabInfo[]>
  listTabs(target: Target): Promise<TabInfo[]>
  newTab(target: Target): Promise<TabInfo[]>
  selectTab(target: Target, index: number): Promise<TabInfo[]>
  closeTab(target: Target, index: number): Promise<TabInfo[]>
  restartClaude(target: Target): Promise<TabInfo[]>

  listFiles(target: Target): Promise<FileList>
  readFile(target: Target, path: string): Promise<FileContent>
  /** data: URL for an image inside the target's folder, or null if too large / not an image / outside. */
  readImage(target: Target, path: string): Promise<string | null>
  /** Repo tasks only; rejects for folders. */
  listChanges(target: Target): Promise<ChangeList>
  /**
   * Unified diff text for one changed file; '' if unchanged. Repo tasks only.
   * Pass the change's `oldPath` for a rename, which spares a whole-tree rename lookup.
   */
  fileDiff(target: Target, path: string, oldPath?: string): Promise<string>
  /**
   * Opens the target's folder (task worktree or folder path) in the editor from Settings, or an auto-detected
   * GUI one. Rejects when the folder is gone or no editor is found.
   */
  openInEditor(target: Target): Promise<void>
  /** Opens the target's folder in the system file manager. */
  openInFileManager(target: Target): Promise<void>
  /** Opens an http(s) URL in the system browser; rejects other schemes. */
  openExternal(url: string): Promise<void>

  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onPtyData(cb: (data: string) => void): () => void
  onPtyExit(cb: (code: number) => void): () => void
}

/** The files of a target, as relative POSIX paths, sorted. */
export interface FileList {
  paths: string[]
  /** Set when the listing stopped at its cap (a very large repo or folder); `paths` is then incomplete. */
  truncated: boolean
}

export type FileContent =
  | { kind: 'text'; content: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number }
  /** A symlink inside the root that points to a folder (listed as an entry, but there is nothing to show). */
  | { kind: 'symlinkToFolder' }
  | { kind: 'missing' }

/** A added, M modified, D deleted, R renamed, U untracked. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'U'

export interface ChangedFile {
  path: string
  /** Set for renames. */
  oldPath?: string
  status: ChangeStatus
  added: number
  removed: number
  binary: boolean
  /** Set on a deletion whose file is still in the work tree: removed from git only (e.g. `git rm --cached`). */
  existsOnDisk?: true
}

export interface ChangeList {
  files: ChangedFile[]
  /** Set when the base ref was missing and only uncommitted changes vs HEAD are shown. */
  fallback?: 'uncommitted-only'
}

/** Usage periods, in the local timezone: today, the last 7 days (today included), this calendar month, all time. */
export type UsagePeriod = 'today' | 'week' | 'month' | 'all'

export const USAGE_PERIODS: readonly UsagePeriod[] = ['today', 'week', 'month', 'all']

/** Token counts and estimated cost of Claude Code messages (from its transcripts), each message counted once. */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /** Estimated USD cost at API prices, for the priced models only. */
  cost: number
  /** Tokens of models without a known price (see shared/pricing.ts); not in `cost`. */
  unpricedTokens: number
  messages: number
  /** Distinct Claude Code sessions. */
  sessions: number
  /** ISO timestamps of the first and last message; null when there are none. */
  firstSeen: string | null
  lastSeen: string | null
}

export interface UsageModelTotals extends UsageTotals {
  /** The model id as Claude Code recorded it, e.g. `claude-opus-5-5`. */
  model: string
  priced: boolean
}

export interface UsageBucket extends UsageTotals {
  /** Per model, costliest first (then by tokens). */
  models: UsageModelTotals[]
}

/** One task's, folder's, theme's or the grand total's usage, per period. */
export type UsageSummary = Record<UsagePeriod, UsageBucket>

export interface UsageTargetReport {
  target: Target
  kind: 'task' | 'folder'
  /** "Repo › Task" or the folder's name. */
  label: string
  /** The worktree or folder path. */
  path: string
  usage: UsageSummary
}

export interface UsageThemeReport {
  themeId: string
  name: string
  usage: UsageSummary
  targets: UsageTargetReport[]
}

export interface UsageReport {
  /** ISO time the report was computed. */
  generatedAt: string
  total: UsageSummary
  themes: UsageThemeReport[]
}
