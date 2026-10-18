export interface Task {
  id: string
  name: string
  slug: string
  branch: string
  worktreePath: string
  baseRef: string
  createdAt: string
}

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

export function hasUnsavedWork(work: UnsavedWork): boolean {
  return work.uncommittedFiles.length > 0 || work.unpushedCommits.length > 0 || Boolean(work.warning)
}

/** The API the renderer sees as `window.api`. */
export interface MeManagerApi {
  getState(): Promise<AppState>
  getStatus(): Promise<LiveStatus>
  checkPrereqs(): Promise<PrereqResult>

  createTheme(name: string): Promise<AppState>
  removeTheme(themeId: string): Promise<AppState>

  pickDirectory(): Promise<string | null>
  addRepo(themeId: string, path: string): Promise<AppState>
  addFolder(themeId: string, path: string): Promise<AppState>
  removeItem(themeId: string, itemId: string): Promise<AppState>

  createTask(themeId: string, repoId: string, name: string): Promise<AppState>
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
