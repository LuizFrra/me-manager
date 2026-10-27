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
  /**
   * When the task was archived (ISO time; see MeManagerApi.archiveTask): its worktree and session are gone, its
   * branch, base and notes are kept. Absent for an active task, and in state files from before archiving existed.
   */
  archivedAt?: string
  /**
   * The task's own limit on its estimated cost, all time, in USD (whole cents within BUDGET_LIMITS, see
   * shared/budget.ts), in place of Settings.taskBudgetUsd. Absent when it has none, and in state files from before.
   */
  budgetUsd?: number
}

/** An archived task has no worktree and no session: nothing may poll, open or attach to it until it is restored. */
export const isArchived = (task: Task): boolean => task.archivedAt !== undefined

export const MAX_TASK_NOTES = 2000

/** The longest initial prompt a new task's Claude can be started with. */
export const MAX_TASK_PROMPT = 10_000

/** Choices for a new task, all optional (see MeManagerApi.createTask). */
export interface NewTaskOptions {
  /** The branch to start from: one of listBranches' `branches`. Omitted: the repo's default (`resolveBaseRef`). */
  baseRef?: string
  /** The first message for Claude, up to MAX_TASK_PROMPT characters. Sent on the first start only. */
  prompt?: string
}

/** The longest text sendToClaude types into Claude's tab (a review: every comment and its note). */
export const MAX_CLAUDE_MESSAGE = 50_000

/**
 * A saved preset for new tasks (Settings.taskTemplates), picked in the New task dialog to prefill its fields, all
 * of which stay editable. See shared/templates.ts for the rules.
 */
export interface TaskTemplate {
  /** Unique among the templates (ignoring case), at most MAX_TEMPLATE_NAME characters. */
  name: string
  /** A pattern for the task's name: `{date}` is today as YYYYMMDD, `{n}` the next number (see expandTaskName). */
  taskName?: string
  /** The base branch to start from, when the repo has it (see templateBase); the repo's default otherwise. */
  base?: string
  /** The initial prompt, up to MAX_TASK_PROMPT characters. */
  prompt?: string
}

/** The longest commit message "Commit all" accepts. */
export const MAX_COMMIT_MESSAGE = 5_000

export interface CommitResult {
  /** The new commit's short sha. */
  sha: string
  /** Files in the commit. */
  files: number
}

export interface PushResult {
  /** The branch pushed (and set as the upstream), e.g. "claude/client-x/fix". */
  branch: string
}

export interface PullRequestResult {
  url: string
  /** False when the branch already had a pull request. */
  created: boolean
}

/** Optional command-line tools the app can use, detected once in main. */
export interface GitTools {
  /** The GitHub CLI, for "Open PR". */
  gh: boolean
}

/** What listChanges compares the work tree with: the task's base (the default), or HEAD for uncommitted changes. */
export type ChangeScope = 'base' | 'uncommitted'

/** The branches a new task can start from. */
export interface BranchList {
  /** The base a task gets when none is chosen, e.g. "origin/main". Always one of `branches`. */
  default: string
  /** `default` first, then origin's branches (`origin/…`, without `origin/HEAD`), then local ones. */
  branches: string[]
}

export interface Repo {
  id: string
  kind: 'repo'
  name: string
  slug: string
  path: string
  tasks: Task[]
  /**
   * A shell command line (e.g. `npm run dev`) that "Run" starts in a `run` tab of any of the repo's tasks, in its
   * worktree. One line, trimmed, at most MAX_RUN_COMMAND characters (see shared/runCommand.ts); absent when unset,
   * and in state files from before run commands existed.
   */
  runCommand?: string
}

export interface Folder {
  id: string
  kind: 'folder'
  name: string
  slug: string
  path: string
  /** Like Repo.runCommand, run in the folder. */
  runCommand?: string
}

export type Item = Repo | Folder

/** A theme's colour, by name (see shared/themeStyle.ts for the palette); never raw CSS. */
export type ThemeColor = 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple'

/** How a theme looks in the sidebar and the palette. Both optional. */
export interface ThemeStyle {
  color?: ThemeColor
  /** A single emoji (one grapheme, at most MAX_THEME_ICON UTF-16 code units). */
  icon?: string
}

export interface Theme extends ThemeStyle {
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

/**
 * What Claude is doing in a session, best-effort (see main/tmux/activity.ts): `busy` printed output in the last
 * few seconds, `waiting` shows a permission prompt or question, `idle` is quiet at its prompt.
 */
export type ClaudeActivity = 'busy' | 'waiting' | 'idle'

/** Ids (task ids for tasks, item ids for folders/repos). */
export interface LiveStatus {
  running: string[]
  missing: string[]
  /** For running sessions that still have their `claude` window, by id. */
  activity: Record<string, ClaudeActivity>
}

/** A repo task's git state, read from its worktree (see GitApi.taskStatus). */
export interface TaskGitStatus {
  /** Commits on HEAD that the base ref doesn't have; 0 when the base ref is missing. */
  ahead: number
  /** Commits on the base ref that HEAD doesn't have; 0 when the base ref is missing. */
  behind: number
  /** Changed, staged and untracked files: one per `git status --porcelain` entry. */
  uncommitted: number
  /** The branch checked out in the worktree; 'HEAD' when detached. */
  branch: string
  /** Set when the base ref could not be resolved (deleted, never fetched, or unsafe); ahead/behind are then 0. */
  baseMissing?: true
  /** HEAD's commit: short sha, subject and committer date relative to now ("2 hours ago"). */
  lastCommit?: { sha: string; subject: string; relativeDate: string }
}

export interface TabInfo {
  index: number
  name: string
  active: boolean
  /**
   * Set when the tab's program has exited and tmux keeps the tab open with its output (remain-on-exit: the
   * `run` tab, see MeManagerApi.startRun). Absent for every other tab, which closes when its program exits.
   */
  dead?: true
}

/** A dev-server URL printed in one of a session's tabs (see MeManagerApi.getDevUrls). */
export interface DevUrl {
  /** Normalized for opening (`http://localhost:5173/`): loopback, http or https, with a port. */
  url: string
  /** The tab it was printed in, as a TabInfo has it. */
  index: number
  tab: string
}

/** The most of a tab's scrollback a transcript holds: beyond it, only the most recent lines are kept. */
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024

/** A tab's whole scrollback as plain text (see MeManagerApi.copyTranscript). */
export interface Transcript {
  /**
   * One line per terminal line (wrapped lines joined), without colours or other escape sequences, trailing spaces
   * or the blank lines below the last output; ends with a newline, or is '' for an empty tab.
   */
  text: string
  lines: number
  /** Set when the scrollback was over MAX_TRANSCRIPT_BYTES: `text` holds its most recent lines only. */
  truncated: boolean
}

/** Where saveTranscript wrote a transcript, and what it held. */
export interface SavedTranscript {
  path: string
  lines: number
  truncated: boolean
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
  /** Start every Claude session with Remote Control on, named `<theme>/<repo>/<task>` (`--remote-control`). */
  remoteControl: boolean
  /** Start every Claude session with `--dangerously-skip-permissions`: Claude runs commands without asking. */
  skipPermissions: boolean
  /**
   * Desktop notifications when Claude finishes or waits for input in a task or folder the user isn't looking at,
   * and when a task or the day reaches 80% or 100% of its budget.
   */
  notifications: boolean
  /** How "Update from base" brings the base's new commits into a task branch. */
  updateStrategy: UpdateStrategy
  /** The folder the last "Clone repository…" cloned into (an absolute path), its default next time; '' if none. */
  cloneDirectory: string
  /** The thin status bar at the bottom of the main area, for the selected task or folder. */
  showStatusBar: boolean
  /** Presets for new tasks, in the order the New task dialog lists them; at most MAX_TASK_TEMPLATES. */
  taskTemplates: TaskTemplate[]
  /**
   * A limit on the estimated cost of all usage today (every task and folder, since local midnight), in USD; null
   * for none. Whole cents within BUDGET_LIMITS (see shared/budget.ts).
   */
  dailyBudgetUsd: number | null
  /** The default limit on each task's estimated cost, all time, in USD (Task.budgetUsd overrides it); null for none. */
  taskBudgetUsd: number | null
  /** Light or dark colours; `system` follows the OS, live. */
  appearance: Appearance
}

/**
 * Whether each built-in Claude flag applies to the sessions the app starts, once the user's own arguments
 * (Settings.claudeArgs) are counted: a toggle is moot when those arguments set the option themselves
 * (`--permission-mode acceptEdits` keeps permissions on), and they can turn it on with the toggle off.
 */
export interface EffectiveClaudeFlags {
  /** `--remote-control` is in the command. */
  remoteControl: boolean
  /** `--dangerously-skip-permissions` or `--permission-mode bypassPermissions` is in the command. */
  skipPermissions: boolean
}

/** Settings as getSettings and updateSettings return them. */
export interface SettingsView extends Settings {
  /**
   * What applies (see EffectiveClaudeFlags), worked out from the settings on every call; never saved, and
   * dropped when sent back in an updateSettings patch. Optional for API stand-ins that predate it.
   */
  effective?: EffectiveClaudeFlags
}

/** `rebase`: `git rebase <base>` (a linear history); `merge`: `git merge --no-edit <base>` (a merge commit). */
export type UpdateStrategy = 'rebase' | 'merge'

export const UPDATE_STRATEGIES: readonly UpdateStrategy[] = ['rebase', 'merge']

/** Settings.appearance. `system` resolves to `dark` or `light` from the OS preference. */
export type Appearance = 'system' | 'dark' | 'light'

export const APPEARANCES: readonly Appearance[] = ['system', 'dark', 'light']

/** What the UI is drawn in: an Appearance with `system` resolved. */
export type ResolvedAppearance = Exclude<Appearance, 'system'>

/** What "Update from base" did. A conflict was undone (`--abort`), leaving the branch and the worktree as they were. */
export type UpdateResult =
  | { kind: 'upToDate'; baseRef: string }
  /** `commits`: how many of the base's commits the branch didn't have. */
  | { kind: 'updated'; strategy: UpdateStrategy; baseRef: string; commits: number }
  | { kind: 'conflict'; strategy: UpdateStrategy; baseRef: string; files: string[] }

export function hasUnsavedWork(work: UnsavedWork): boolean {
  return work.uncommittedFiles.length > 0 || work.unpushedCommits.length > 0 || Boolean(work.warning)
}

/** The side panel's tabs. */
export type PanelTabName = 'files' | 'changes' | 'search'

/** What the side panel showed for one target, remembered across restarts. */
export interface UiPanelState {
  open: boolean
  tab: PanelTabName
  /** The selected file (root-relative). */
  selected?: string
}

/**
 * The UI as it was left, restored at the next start (ui-state.json next to state.json). Always normalized against
 * the current AppState: see normalizeUiState.
 */
export interface UiState {
  version: 1
  /** The selected task or folder. */
  selected?: Target
  /** Ids of collapsed themes and repos. */
  collapsed: string[]
  /** Side panel state by targetKey, least recently changed first. */
  panels: Record<string, UiPanelState>
  /** The side panel's width, as a fraction of the workspace. */
  panelWidth?: number
  /** The sidebar filter's text; absent when empty. */
  sidebarFilter?: string
  /** Ids of repos whose "Archived" group is expanded (each starts collapsed); absent when there are none. */
  archivedOpen?: string[]
  /**
   * The task template last used to create a task in each repo, by repo id: the New task dialog starts on it.
   * Names only; one that no longer names a template is ignored. Absent when there are none.
   */
  lastTemplates?: Record<string, string>
  /** True while the sidebar is collapsed to its rail of icons; absent when it is shown. */
  sidebarCollapsed?: true
}

/** The API the renderer sees as `window.api`. */
export interface MeManagerApi {
  getState(): Promise<AppState>
  getStatus(): Promise<LiveStatus>
  /**
   * Git status of the given repo tasks, by targetKey. Folders, unknown targets, missing worktrees and failed
   * checks are left out. Cheap to poll: each worktree is read at most once every few seconds.
   */
  getGitStatus(targets: Target[]): Promise<Record<string, TaskGitStatus>>
  checkPrereqs(): Promise<PrereqResult>
  /** The `tmux -L` socket name the app's sessions live on, for "copy attach command". */
  getTmuxSocket(): Promise<string>

  /** The UI state saved by the last saveUiState, normalized: targets that no longer exist are dropped. */
  getUiState(): Promise<UiState>
  /** Normalizes (see normalizeUiState) and saves the UI state for the next start. Saves run one at a time. */
  saveUiState(state: UiState): Promise<void>

  /** The settings, with which built-in Claude flags apply (`effective`). */
  getSettings(): Promise<SettingsView>
  /**
   * Merges the patch into the settings, normalized (see normalizeSettings), saves and returns the result, with
   * `effective` as getSettings has it.
   */
  updateSettings(patch: Partial<Settings>): Promise<SettingsView>

  createTheme(name: string): Promise<AppState>
  /** Display name only; the slug (and so branches, worktree paths and sessions) never changes. */
  renameTheme(themeId: string, name: string): Promise<AppState>
  /**
   * Sets the theme's colour and icon (see normalizeThemeStyle): a field left out, null or '' removes it. Rejects
   * an unknown colour or an icon that is not a single emoji.
   */
  customizeTheme(themeId: string, style: ThemeStyle): Promise<AppState>
  /** Removes the theme from the app only (nothing on disk); refused while it has tasks. Kills its folder sessions. */
  removeTheme(themeId: string): Promise<AppState>
  /**
   * Undoes removeTheme: re-adds the theme as it was (same id, name, slug, style, items), at `index` (its old position)
   * when given. Rejects it when its id, slug or name, or one of its items, is in use meanwhile.
   */
  restoreTheme(theme: Theme, index?: number): Promise<AppState>

  /**
   * Moves the theme to index `toIndex` among the themes, clamped to the list. Resolves with the state unchanged,
   * saving nothing, when it is already there. Rejects an unknown theme or a position that is not an integer.
   */
  moveTheme(themeId: string, toIndex: number): Promise<AppState>

  pickDirectory(): Promise<string | null>
  addRepo(themeId: string, path: string): Promise<AppState>
  /**
   * Clones `url` (see shared/clone.ts for what is accepted) into `<parentDir>/<name>`, which must not exist yet,
   * then adds it to the theme like addRepo and remembers `parentDir` as Settings.cloneDirectory. Runs
   * `git clone` non-interactively, for up to 10 minutes; there is no progress report (the dialog shows
   * "Cloning…"). On failure the folder it created is removed again and git's error is the rejection.
   */
  cloneRepo(themeId: string, url: string, parentDir: string, name: string): Promise<AppState>
  addFolder(themeId: string, path: string): Promise<AppState>
  /**
   * Sets the run command of a repo (for every one of its tasks) or folder: one line of shell, trimmed, at most
   * MAX_RUN_COMMAND characters (see shared/runCommand.ts); '' removes it. It applies from the next Run or Restart.
   */
  setRunCommand(themeId: string, itemId: string, command: string): Promise<AppState>
  /** Removes a repo or folder from the theme only (nothing on disk); refused for a repo with tasks. */
  removeItem(themeId: string, itemId: string): Promise<AppState>
  /**
   * Undoes removeItem: re-adds the repo (without tasks) or folder with the same id, name, slug and path, at
   * `index` when given. Rejects it when its id, path or slug is in use meanwhile. A folder's session isn't restarted.
   */
  restoreItem(themeId: string, item: Item, index?: number): Promise<AppState>

  /**
   * Moves a repo or folder to index `toIndex` within its theme, clamped, like moveTheme. Never to another theme: its
   * tasks' branches and worktree paths hold the theme's slug.
   */
  moveItem(themeId: string, itemId: string, toIndex: number): Promise<AppState>

  /**
   * Fetches origin (giving up after a timeout, like createTask), then lists the branches a new task in the repo can
   * start from, with the default one.
   */
  listBranches(themeId: string, repoId: string): Promise<BranchList>
  /**
   * Creates the task's worktree from `options.baseRef` (checked against listBranches) or the default base, and
   * starts Claude in it, with `options.prompt` as its first message.
   */
  createTask(themeId: string, repoId: string, name: string, options?: NewTaskOptions): Promise<AppState>
  /** Display name only; the slug, branch, worktree path and tmux session never change. */
  renameTask(themeId: string, repoId: string, taskId: string, name: string): Promise<AppState>
  /** Up to MAX_TASK_NOTES characters; an empty string removes the notes. */
  setTaskNotes(themeId: string, repoId: string, taskId: string, notes: string): Promise<AppState>
  /**
   * Sets the task's own budget (Task.budgetUsd) in USD, rounded to cents; null removes it, so the default
   * (Settings.taskBudgetUsd) applies again. Rejects an amount outside BUDGET_LIMITS.
   */
  setTaskBudget(themeId: string, repoId: string, taskId: string, budgetUsd: number | null): Promise<AppState>
  /**
   * What removing (or archiving) the task would lose: uncommitted and untracked files in its worktree (none for an
   * archived task, which has no worktree) and commits on its branch that neither its base nor a remote has.
   */
  checkTaskRemoval(themeId: string, repoId: string, taskId: string): Promise<UnsavedWork>
  /**
   * Kills the session, removes the worktree and drops the task, deleting its branch too when asked. An archived
   * task has no worktree or session left, so only the branch (when asked) and the task go.
   */
  removeTask(themeId: string, repoId: string, taskId: string, deleteBranch: boolean): Promise<AppState>
  /**
   * Kills the task's session and removes its worktree, keeping its branch; the task stays, with `archivedAt` set.
   * Refuses ("Commit or discard the changes first") while the worktree has uncommitted or untracked files, or
   * could not be checked, unless `force`, which discards them. Refused for an archived task, and when the original
   * repository is gone (its branch with it).
   */
  archiveTask(themeId: string, repoId: string, taskId: string, force?: boolean): Promise<AppState>
  /**
   * Restores an archived task: recreates its worktree at its usual path from its kept branch (no new branch) and
   * clears `archivedAt`. The session starts when the task is next opened, as for any task. Refuses when the branch
   * no longer exists or something is at the worktree path.
   */
  unarchiveTask(themeId: string, repoId: string, taskId: string): Promise<AppState>

  /**
   * Moves an active task to position `toIndex` among its repo's active tasks (the order the sidebar lists them and
   * Alt+1..9 counts), clamped, like moveTheme; archived tasks keep their places. Refused for an archived task.
   */
  moveTask(themeId: string, repoId: string, taskId: string, toIndex: number): Promise<AppState>

  openTarget(target: Target): Promise<TabInfo[]>
  /** Detaches the terminal (an archived task is selected): no session is shown, so none counts as selected. */
  detachTerminal(): Promise<void>
  listTabs(target: Target): Promise<TabInfo[]>
  newTab(target: Target): Promise<TabInfo[]>
  selectTab(target: Target, index: number): Promise<TabInfo[]>
  closeTab(target: Target, index: number): Promise<TabInfo[]>
  restartClaude(target: Target): Promise<TabInfo[]>
  /**
   * Leaves copy mode in the target's active tab, if it is in it. After a scroll back, tmux (not the program) gets
   * the keys: the terminal calls this before it sends the next one.
   */
  leaveCopyMode(target: Target): Promise<void>
  /**
   * Shows the target's `run` tab, or opens one (active) that runs its repo's or folder's run command with the
   * user's shell in the worktree or folder. The tab stays open with the output when the command exits, as a `dead`
   * TabInfo. Refuses without a run command, or when the session isn't running.
   */
  startRun(target: Target): Promise<TabInfo[]>
  /**
   * Runs the run command again in the `run` tab, and shows it: a running one gets Ctrl-C, a moment to shut down,
   * and is killed if it still runs. Opens the tab when there is none. Refuses like startRun.
   */
  restartRun(target: Target): Promise<TabInfo[]>
  /** Ctrl-C in the `run` tab, if its command is running; the tab stays open with the output. */
  stopRun(target: Target): Promise<TabInfo[]>
  /**
   * Dev-server URLs (see shared/devUrls.ts: loopback http(s) with a port) printed on the screen or in the last few
   * hundred lines of the target's open tabs: from the tab that printed last first, newest first within a tab, once
   * each, at most MAX_DEV_URLS. [] when the session isn't running. Cheap to poll: a tab is captured again only
   * after it printed something, and at most every few seconds.
   */
  getDevUrls(target: Target): Promise<DevUrl[]>
  /**
   * The scrollback of the tab at `index` (a TabInfo.index of the target's session) as plain text, for the renderer
   * to put on the clipboard. Rejects when the session isn't running or has no tab at `index`.
   */
  copyTranscript(target: Target, index: number): Promise<Transcript>
  /**
   * Captures the tab like copyTranscript, then asks where to save it with a save dialog that suggests
   * `<theme>-<task or folder>-<tab>-<YYYYMMDD-HHMM>.txt` in Downloads, and writes it there. null when cancelled.
   */
  saveTranscript(target: Target, index: number): Promise<SavedTranscript | null>

  listFiles(target: Target): Promise<FileList>
  readFile(target: Target, path: string): Promise<FileContent>
  /** data: URL for an image inside the target's folder, or null if too large / not an image / outside. */
  readImage(target: Target, path: string): Promise<string | null>
  /**
   * Searches the contents of the target's files, one match per line, up to MAX_SEARCH_MATCHES, giving up after
   * 10 s. Repos: `git grep` over tracked and untracked, not ignored files. Folders: the files listFiles shows.
   * Binary files are skipped. Rejects an empty or too long query, and an invalid regular expression.
   */
  searchFiles(target: Target, query: string, options?: SearchOptions): Promise<SearchResult>
  /** Gives up the target's running searchFiles, if any (it rejects): its query was cleared or changed. */
  cancelSearch(target: Target): Promise<void>
  /** Repo tasks only; rejects for folders. `uncommitted`: only what a commit would take (vs HEAD). */
  listChanges(target: Target, scope?: ChangeScope): Promise<ChangeList>
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

  /** Which optional tools (gh) are on PATH; detected once. */
  getGitTools(): Promise<GitTools>
  /**
   * `git add -A` and `git commit -m <message>` in a task's worktree. The message is trimmed and must not be empty
   * or over MAX_COMMIT_MESSAGE characters. Rejects with git's message (e.g. no identity configured).
   */
  commitAll(target: Target, message: string): Promise<CommitResult>
  /** `git push -u origin <branch>`, non-interactive, with a timeout. Rejects with git's error summary. */
  pushTask(target: Target): Promise<PushResult>
  /**
   * Creates a pull request for the task's branch into its base branch with `gh pr create --fill`, unless one
   * exists, and returns its URL (the renderer opens it with openExternal). Rejects when gh is not installed.
   */
  createPullRequest(target: Target): Promise<PullRequestResult>
  /**
   * Fetches origin (with the usual timeout), then rebases the task branch onto its base ref, or merges the base
   * into it (Settings.updateStrategy). Refuses when the worktree has uncommitted changes. On conflicts the rebase
   * or merge is aborted and the conflicting files are reported.
   */
  updateFromBase(target: Target): Promise<UpdateResult>
  /**
   * Types a request to rebase (or merge) and resolve the conflicts in `files` into the task's Claude window,
   * then Enter, and selects that window. Starts Claude (continuing its conversation) when its window was closed.
   * Refuses, typing nothing, while Claude waits for an answer ("Claude is waiting for input — answer it first")
   * or is busy ("Claude is busy — try again when it's idle"), as Enter would pick a menu option.
   */
  askClaudeToResolve(target: Target, strategy: UpdateStrategy, files: string[]): Promise<TabInfo[]>
  /**
   * Pastes `text` (review comments) into the Claude tab of a task or folder, without pressing Enter, so the user
   * reads it and submits it, and selects that tab. Line endings become `\n`, other control characters `?`; refuses
   * an empty text or one over MAX_CLAUDE_MESSAGE characters. Refuses, typing nothing, when the session isn't
   * running, when there is no Claude tab (it is not restarted), and while Claude waits for input or is busy, like
   * askClaudeToResolve.
   */
  sendToClaude(target: Target, text: string): Promise<TabInfo[]>

  /**
   * Claude usage of one task or folder, from Claude Code's transcripts (`~/.claude/projects`). A message counts
   * for the most specific task or folder whose path contains its working directory.
   */
  getUsage(target: Target): Promise<UsageSummary>
  /** Usage of every task and folder, per theme, with totals. Cheap to call again: it is computed from a cache. */
  getUsageReport(): Promise<UsageReport>
  /**
   * Where the daily budget and each active task's budget stand, from the same cached usage as getUsageReport.
   * Reads no usage at all while no budget is set.
   */
  getBudgets(): Promise<BudgetReport>

  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  /** Where a file dragged in from the desktop is on disk; '' for one that isn't a local file. Synchronous. */
  pathForFile(file: File): string
  onPtyData(cb: (data: string) => void): () => void
  onPtyExit(cb: (code: number) => void): () => void
  /** Main asks to select a target (a desktop notification for it was clicked). Returns an unsubscribe function. */
  onSelectTarget(cb: (target: Target) => void): () => void
  /**
   * A budget reached 80% or 100% while the window was focused (a desktop notification is sent too, if
   * notifications are on). Returns an unsubscribe function.
   */
  onBudgetAlert(cb: (alert: BudgetAlert) => void): () => void
}

/** The files of a target, as relative POSIX paths, sorted. */
export interface FileList {
  paths: string[]
  /** Set when the listing stopped at its cap (a very large repo or folder); `paths` is then incomplete. */
  truncated: boolean
}

export type FileContent =
  | { kind: 'text'; content: string; size: number; truncated: boolean }
  /** `mtimeMs` tells versions apart: an image overwritten with the same size is shown again. */
  | { kind: 'binary'; size: number; mtimeMs: number }
  /** A symlink inside the root that points to a folder (listed as an entry, but there is nothing to show). */
  | { kind: 'symlinkToFolder' }
  | { kind: 'missing' }

/** How searchFiles matches the query. Both are off by default: a case-insensitive search for the literal text. */
export interface SearchOptions {
  caseSensitive?: boolean
  /**
   * The query is a regular expression, JavaScript syntax: Perl-compatible `git grep -P` in repos (POSIX extended
   * `-E` when git lacks PCRE, see SearchResult.note), JavaScript in folders. It must compile in JavaScript.
   */
  regex?: boolean
}

/** A line matching a search: the first match on it. */
export interface SearchMatch {
  /** Root-relative POSIX path. */
  path: string
  /** 1-based line number. */
  line: number
  /** 1-based character column of the match in the line. */
  column: number
  /** The line, without its indentation, cut to MAX_SEARCH_PREVIEW characters around the match. */
  preview: string
  /** Where the match is in `preview` (characters), for highlighting; `matchLength` may be 0 if unknown. */
  matchStart: number
  matchLength: number
}

export interface SearchResult {
  matches: SearchMatch[]
  /** Set when the search stopped at MAX_SEARCH_MATCHES, or didn't reach every file (a huge folder). */
  truncated: boolean
  /** Something to tell the user about how the search ran (e.g. a repo regex read as POSIX extended); rare. */
  note?: string
}

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

/** How a cost compares with its budget (see shared/budget.ts): `warn` from 80% of it, `over` from 100%. */
export type BudgetLevel = 'ok' | 'warn' | 'over'

export interface BudgetStatus {
  level: BudgetLevel
  /** Estimated USD cost so far (see UsageTotals.cost). */
  spent: number
  /** The budget, in USD. */
  limit: number
  /** spent / limit: 1 is the whole budget, above 1 over it. */
  fraction: number
}

/** Where every budget stands (see MeManagerApi.getBudgets). */
export interface BudgetReport {
  /** All usage today (every task and folder, since local midnight) against Settings.dailyBudgetUsd; null for none. */
  daily: BudgetStatus | null
  /**
   * Each active (not archived) task that has a budget (Task.budgetUsd, else Settings.taskBudgetUsd): its all-time
   * cost against it, by task id.
   */
  tasks: Record<string, BudgetStatus>
}

/** A budget that reached 80% or 100%, for an in-app toast (see MeManagerApi.onBudgetAlert). */
export interface BudgetAlert {
  /** e.g. "Task over its budget". */
  title: string
  /** e.g. "Client X › my-api › Fix login: $5.10 of $5.00 task budget". */
  body: string
  level: Exclude<BudgetLevel, 'ok'>
  /** The task, for a task's budget; absent for the daily one. */
  target?: Target
}

export interface UsageReport {
  /** ISO time the report was computed. */
  generatedAt: string
  total: UsageSummary
  themes: UsageThemeReport[]
}
