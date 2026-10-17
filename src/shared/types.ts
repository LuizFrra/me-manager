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

  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onPtyData(cb: (data: string) => void): () => void
  onPtyExit(cb: (code: number) => void): () => void
}
