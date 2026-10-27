import {
  MAX_COMMIT_MESSAGE,
  MAX_TASK_NOTES,
  MAX_TASK_PROMPT,
  PROFILE_BILLINGS,
  type AppState,
  type ClaudeProfile,
  type MeManagerApi,
  type ProfileBilling,
  type ProfileStatus,
  type SearchMatch,
  type Settings,
  type TabInfo,
  type Target,
  type Task,
  type TaskGitStatus,
  type Theme,
  type Transcript,
  type UiState,
} from '../../../shared/types'
import { branchName, slugify, targetKey } from '../../../shared/naming'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../../shared/settings'
import {
  checkSearchQuery,
  makeMatch,
  MAX_SEARCH_MATCHES,
  normalizeSearchOptions,
  searchPattern,
} from '../../../shared/search'
import { emptyUiState, normalizeUiState } from '../../../shared/uiState'
import { checkCloneName, checkCloneUrl } from '../../../shared/clone'
import { normalizeThemeStyle } from '../../../shared/themeStyle'
import { normalizeRunCommand, RUN_WINDOW } from '../../../shared/runCommand'
import { moveActiveTask, moveEntry } from '../../../shared/reorder'
import { normalizeBudget } from '../../../shared/budget'
import {
  allProfiles,
  DEFAULT_PROFILE_ID,
  effectiveProfileId,
  MAX_PROFILES,
  normalizeConfigDir,
  profileError,
} from '../../../shared/profiles'
import { demoBudgets, demoUsage, demoUsageReport } from './demoUsage'
import { DEMO_BINARY, DEMO_CHANGES, DEMO_DIFFS, DEMO_FILES, DEMO_PATHS, DEMO_PNG_BASE64 } from './demoFiles'

/** The demo's Default Claude profile folder. */
const DEMO_CLAUDE_DIR = '/home/demo/.claude'

/** The branches a demo task can start from; listBranches' default is the first. */
const DEMO_BRANCHES = ['origin/main', 'origin/develop', 'origin/release/2.0', 'main']

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The checks main makes on a new display name: trimmed, not empty, not taken (ignoring case). */
function checkName(name: string, what: string, taken: { id: string; name: string }[], selfId: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(`${what} name can't be empty`)
  if (taken.some((x) => x.id !== selfId && x.name.toLowerCase() === trimmed.toLowerCase()))
    throw new Error(`A ${what.toLowerCase()} named "${trimmed}" already exists`)
  return trimmed
}

/** A plausible git status for the browser demo, varied by task name so the badges differ between rows. */
export function demoGitStatus(name: string, branch: string): TaskGitStatus {
  const n = [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0)
  return {
    ahead: n % 4,
    behind: n % 3 === 0 ? 1 : 0,
    uncommitted: n % 5,
    branch,
    lastCommit: {
      sha: (n * 2654435761).toString(16).slice(-7).padStart(7, '0'),
      subject: `Work on ${name}`,
      relativeDate: `${(n % 50) + 1} minutes ago`,
    },
  }
}

/** In-memory MeManagerApi for tests and for running the UI in a browser. */
export function createMockApi(overrides: Partial<MeManagerApi> = {}): MeManagerApi {
  let state: AppState = { version: 1, themes: [] }
  let counter = 0
  const id = (): string => `id-${++counter}`
  const tabs: TabInfo[] = [{ index: 0, name: 'claude', active: true }]
  let settings: Settings = normalizeSettings(DEFAULT_SETTINGS)
  let uiState: UiState = emptyUiState()

  /** Tasks that have a demo pull request, and those already updated from their base. */
  const prs = new Set<string>()
  const updated = new Set<string>()
  const taskOf = (target: Target): Task => {
    const item = state.themes.find((t) => t.id === target.themeId)?.items.find((i) => i.id === target.itemId)
    const task = item?.kind === 'repo' ? item.tasks.find((t) => t.id === target.taskId) : undefined
    if (!task) throw new Error('Git actions are only available for repository tasks')
    return task
  }

  /** The demo transcript of one of the tabs; rejects an index that isn't one, like main. */
  const transcriptOf = (index: number): { tab: TabInfo; transcript: Transcript } => {
    const tab = tabs.find((t) => t.index === index)
    if (!tab) throw new Error('That tab is no longer open')
    const text = ['$ npm test', '', ' Test Files  74 passed (74)', '      Tests  1021 passed (1021)', ''].join('\n')
    return { tab, transcript: { text, lines: 4, truncated: false } }
  }

  const taskIn = (theme: Theme, repoId: string, taskId: string): Task => {
    const repo = theme.items.find((i) => i.id === repoId)
    const task = repo?.kind === 'repo' ? repo.tasks.find((k) => k.id === taskId) : undefined
    if (!task) throw new Error(`Task not found: ${taskId}`)
    return task
  }

  /** Makes the tab at `index` the active one, like selecting a tmux window. */
  const activate = (index: number): void => {
    for (const tab of tabs) tab.active = tab.index === index
  }
  /** The demo's run tab, opened (active) or shown; refuses like main without a run command. */
  const run = (target: Target, restart: boolean): TabInfo[] => {
    const item = state.themes.find((t) => t.id === target.themeId)?.items.find((i) => i.id === target.itemId)
    if (!item?.runCommand) throw new Error(`Set a run command for “${item?.name ?? '?'}” first`)
    let tab = tabs.find((t) => t.name === RUN_WINDOW)
    if (!tab)
      tabs.push((tab = { index: Math.max(-1, ...tabs.map((t) => t.index)) + 1, name: RUN_WINDOW, active: true }))
    if (restart) delete tab.dead
    activate(tab.index)
    return clone(tabs)
  }

  /**
   * The account each demo Claude was started in, by targetKey, as main reports it (LiveStatus.claudeProfiles): set
   * when a task is created or opened the first time, and when Restart Claude replaces it.
   */
  const claudeRuns = new Map<string, string>()
  const startClaude = (target: Target, replace: boolean): void => {
    const key = targetKey(target)
    if (claudeRuns.has(key) && !replace) return
    const theme = state.themes.find((t) => t.id === target.themeId)
    const item = theme?.items.find((i) => i.id === target.itemId)
    const task = item?.kind === 'repo' ? item.tasks.find((k) => k.id === target.taskId) : undefined
    if (!theme || !item || (target.taskId && !task)) return // the demo opens anything, as it always has
    claudeRuns.set(key, effectiveProfileId(allProfiles(settings, DEMO_CLAUDE_DIR), theme, task).id)
  }

  /** Like main: an id no profile has is refused (null, for none, is fine). */
  const checkProfile = (profileId: string | null): void => {
    if (profileId !== null && !allProfiles(settings, DEMO_CLAUDE_DIR).some((p) => p.id === profileId))
      throw new Error('Claude account not found')
  }

  /** The demo's profiles: Default signed in, the ones added not (yet). */
  const profiles = (): ProfileStatus[] =>
    allProfiles(settings, DEMO_CLAUDE_DIR).map((p) => ({
      ...p,
      isDefault: p.id === DEFAULT_PROFILE_ID,
      login: p.id === DEFAULT_PROFILE_ID ? 'signedIn' : 'notSignedIn',
    }))
  const checked = (error: string | null): void => {
    if (error) throw new Error(error)
  }
  const checkBilling = (billing: unknown): void => {
    if (!PROFILE_BILLINGS.includes(billing as ProfileBilling)) throw new Error('Choose who pays for this account')
  }
  /** What uses the profile, as main names it when it refuses to remove one. */
  const profileUsers = (id: string): string[] =>
    state.themes.flatMap((t) => [
      ...(t.profileId === id ? [t.name] : []),
      ...t.items.flatMap((i) =>
        i.kind === 'repo'
          ? i.tasks.filter((k) => k.profileId === id).map((k) => `${t.name} › ${i.name} › ${k.name}`)
          : [],
      ),
    ])

  const edit = async (themeId: string, fn: (t: Theme) => void): Promise<AppState> => {
    const next = clone(state)
    const theme = next.themes.find((t) => t.id === themeId)
    if (!theme) throw new Error(`Theme not found: ${themeId}`)
    fn(theme)
    state = next
    return state
  }

  const api: MeManagerApi = {
    getState: async () => state,
    getStatus: async () => ({
      running: [],
      missing: [],
      activity: {},
      claudeProfiles: Object.fromEntries(claudeRuns),
    }),
    getGitStatus: async (targets) => {
      const out: Record<string, TaskGitStatus> = {}
      for (const target of targets) {
        const item = state.themes.find((t) => t.id === target.themeId)?.items.find((i) => i.id === target.itemId)
        const task = item?.kind === 'repo' ? item.tasks.find((t) => t.id === target.taskId) : undefined
        if (task) out[task.id] = demoGitStatus(task.name, task.branch)
      }
      return out
    },
    checkPrereqs: async () => ({ ok: true, missing: [] }),
    getTmuxSocket: async () => 'me-manager',
    // Normalized against the state on the way out and in, like main does.
    getUiState: async () => normalizeUiState(clone(uiState), state),
    saveUiState: async (next) => {
      uiState = normalizeUiState(clone(next), state)
    },
    getSettings: async () => clone(settings),
    // Like main, the Claude profiles are left out: they have their own calls.
    updateSettings: async (patch) => {
      const rest = { ...patch }
      delete rest.profiles
      delete rest.defaultProfileBilling
      settings = normalizeSettings({ ...settings, ...rest }, settings)
      return clone(settings)
    },
    createTheme: async (name) => {
      state = { ...state, themes: [...state.themes, { id: id(), name, slug: slugify(name), items: [] }] }
      return state
    },
    renameTheme: (themeId, name) =>
      edit(themeId, (t) => {
        t.name = checkName(name, 'Theme', state.themes, themeId)
      }),
    // Checked like main: a known colour name and a single emoji; what is left out is removed.
    customizeTheme: (themeId, raw) =>
      edit(themeId, (t) => {
        const style = normalizeThemeStyle(raw)
        delete t.color
        delete t.icon
        Object.assign(t, style)
      }),
    removeTheme: async (themeId) => {
      const theme = state.themes.find((t) => t.id === themeId)
      if (theme?.items.some((i) => i.kind === 'repo' && i.tasks.length > 0))
        throw new Error(`Remove the tasks in "${theme.name}" first`)
      state = { ...state, themes: state.themes.filter((t) => t.id !== themeId) }
      return state
    },
    // Like main: back with the same ids, at the old position, unless something took its place meanwhile.
    restoreTheme: async (theme, index) => {
      if (state.themes.some((t) => t.id === theme.id || t.slug === theme.slug || sameName(t.name, theme.name)))
        throw new Error(`A theme named "${theme.name}" already exists`)
      const themes = [...state.themes]
      themes.splice(index ?? themes.length, 0, clone(theme))
      state = { ...state, themes }
      return state
    },
    // Clamped like main, which also saves nothing when nothing moves.
    moveTheme: async (themeId, toIndex) => {
      const from = state.themes.findIndex((t) => t.id === themeId)
      if (from === -1) throw new Error(`Theme not found: ${themeId}`)
      state = { ...state, themes: [...moveEntry(state.themes, from, toIndex)] }
      return state
    },
    pickDirectory: async () => `/home/demo/project-${++counter}`,
    addRepo: (themeId, path) =>
      edit(themeId, (t) => {
        t.items.push({ id: id(), kind: 'repo', name: baseName(path), slug: slugify(baseName(path)), path, tasks: [] })
      }),
    // Checked like main; a folder some theme already has counts as existing.
    cloneRepo: async (themeId, url, parentDir, name) => {
      checkCloneUrl(url)
      const folder = checkCloneName(name)
      if (!parentDir.startsWith('/')) throw new Error('Choose the folder to clone into')
      const path = `${parentDir.replace(/\/+$/, '')}/${folder}`
      if (state.themes.some((t) => t.items.some((i) => i.path === path)))
        throw new Error(`${path} already exists; choose another folder name`)
      const next = await api.addRepo(themeId, path)
      settings = { ...settings, cloneDirectory: parentDir }
      return next
    },
    addFolder: (themeId, path) =>
      edit(themeId, (t) => {
        t.items.push({ id: id(), kind: 'folder', name: baseName(path), slug: slugify(baseName(path)), path })
      }),
    removeItem: (themeId, itemId) =>
      edit(themeId, (t) => {
        const item = t.items.find((i) => i.id === itemId)
        if (item?.kind === 'repo' && item.tasks.length > 0) throw new Error(`Remove the tasks in "${item.name}" first`)
        t.items = t.items.filter((i) => i.id !== itemId)
      }),
    setRunCommand: (themeId, itemId, command) =>
      edit(themeId, (t) => {
        const item = t.items.find((i) => i.id === itemId)
        if (!item) throw new Error(`Item not found: ${itemId}`)
        const runCommand = normalizeRunCommand(command)
        if (runCommand) item.runCommand = runCommand
        else delete item.runCommand
      }),
    restoreItem: (themeId, item, index) =>
      edit(themeId, (t) => {
        if (t.items.some((i) => i.id === item.id || i.path === item.path))
          throw new Error(`${item.path} is already in this theme`)
        if (t.items.some((i) => i.slug === item.slug))
          throw new Error(`An item named "${item.name}" already exists in this theme`)
        t.items.splice(index ?? t.items.length, 0, clone(item))
      }),
    moveItem: (themeId, itemId, toIndex) =>
      edit(themeId, (t) => {
        const from = t.items.findIndex((i) => i.id === itemId)
        if (from === -1) throw new Error(`Item not found: ${itemId}`)
        t.items = [...moveEntry(t.items, from, toIndex)]
      }),
    listBranches: async () => ({ default: 'origin/main', branches: [...DEMO_BRANCHES] }),
    createTask: async (themeId, repoId, name, options = {}) => {
      const next = await edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind !== 'repo') throw new Error('Repository not found')
        const baseRef = options.baseRef || 'origin/main'
        if (!DEMO_BRANCHES.includes(baseRef)) throw new Error(`Unknown base branch: ${baseRef}`)
        if ((options.prompt ?? '').length > MAX_TASK_PROMPT)
          throw new Error(`The initial prompt is limited to ${MAX_TASK_PROMPT} characters`)
        const slug = slugify(name)
        repo.tasks.push({
          id: id(),
          name,
          slug,
          branch: branchName(t.slug, slug),
          worktreePath: `/home/demo/.me-manager/worktrees/${t.slug}/${repo.slug}/${slug}`,
          baseRef,
          createdAt: new Date().toISOString(),
        })
      })
      const repo = next.themes.find((t) => t.id === themeId)?.items.find((i) => i.id === repoId)
      const task = repo?.kind === 'repo' ? repo.tasks.at(-1) : undefined
      if (task) startClaude({ themeId, itemId: repoId, taskId: task.id }, true)
      return next
    },
    renameTask: (themeId, repoId, taskId, name) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        const task = repo?.kind === 'repo' ? repo.tasks.find((k) => k.id === taskId) : undefined
        if (repo?.kind !== 'repo' || !task) throw new Error(`Task not found: ${taskId}`)
        task.name = checkName(name, 'Task', repo.tasks, taskId)
      }),
    setTaskNotes: (themeId, repoId, taskId, notes) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        const task = repo?.kind === 'repo' ? repo.tasks.find((k) => k.id === taskId) : undefined
        if (!task) throw new Error(`Task not found: ${taskId}`)
        const trimmed = notes.trim()
        if (trimmed.length > MAX_TASK_NOTES) throw new Error(`Notes are limited to ${MAX_TASK_NOTES} characters`)
        if (trimmed) task.notes = trimmed
        else delete task.notes
      }),
    setTaskBudget: (themeId, repoId, taskId, budgetUsd) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        const task = repo?.kind === 'repo' ? repo.tasks.find((k) => k.id === taskId) : undefined
        if (!task) throw new Error(`Task not found: ${taskId}`)
        const budget = normalizeBudget(budgetUsd)
        if (budget === null) delete task.budgetUsd
        else task.budgetUsd = budget
      }),
    setThemeProfile: (themeId, profileId) =>
      edit(themeId, (t) => {
        checkProfile(profileId)
        if (profileId === null) delete t.profileId
        else t.profileId = profileId
      }),
    setTaskProfile: (themeId, repoId, taskId, profileId) =>
      edit(themeId, (t) => {
        const task = taskIn(t, repoId, taskId)
        checkProfile(profileId)
        if (profileId === null) delete task.profileId
        else task.profileId = profileId
      }),
    listProfiles: async () => profiles(),
    // Checked like main; `~/` is the demo's home folder.
    addProfile: async ({ name, configDir, billing }) => {
      const dir = configDir.trim().replace(/^~\//, '/home/demo/')
      checked(profileError({ name, configDir: dir }, profiles()))
      checkBilling(billing)
      if (settings.profiles.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} Claude accounts`)
      const profile = { id: id(), name: name.trim(), configDir: normalizeConfigDir(dir), billing }
      settings = { ...settings, profiles: [...settings.profiles, profile] }
      return profiles()
    },
    updateProfile: async (profileId, { name, billing }) => {
      const profile = profiles().find((p) => p.id === profileId)
      if (!profile) throw new Error('Claude account not found')
      if (billing !== undefined) checkBilling(billing)
      if (profile.isDefault) {
        if (name !== undefined) throw new Error("Default can't be renamed")
        if (billing) settings = { ...settings, defaultProfileBilling: billing }
        return profiles()
      }
      if (name !== undefined) {
        checked(
          profileError(
            { name, configDir: profile.configDir },
            profiles().filter((p) => p.id !== profileId),
          ),
        )
      }
      const edited = (p: ClaudeProfile): ClaudeProfile => ({
        ...p,
        name: name?.trim() ?? p.name,
        billing: billing ?? p.billing,
      })
      settings = { ...settings, profiles: settings.profiles.map((p) => (p.id === profileId ? edited(p) : p)) }
      return profiles()
    },
    removeProfile: async (profileId) => {
      if (!profiles().some((p) => p.id === profileId)) throw new Error('Claude account not found')
      if (profileId === DEFAULT_PROFILE_ID) throw new Error("Default can't be removed")
      const users = profileUsers(profileId)
      if (users.length > 0) throw new Error(`Used by ${users.slice(0, 3).join(', ')}${users.length > 3 ? ', …' : ''}`)
      settings = { ...settings, profiles: settings.profiles.filter((p) => p.id !== profileId) }
      return profiles()
    },
    // A new active `login` tab, like main.
    loginProfile: async (profileId) => {
      if (!profiles().some((p) => p.id === profileId)) throw new Error('Claude account not found')
      const index = Math.max(-1, ...tabs.map((t) => t.index)) + 1
      tabs.push({ index, name: 'login', active: true })
      activate(index)
      return clone(tabs)
    },
    checkTaskRemoval: async () => ({ uncommittedFiles: [], unpushedCommits: [] }),
    removeTask: async (themeId, repoId, taskId) => ({
      state: await edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind === 'repo') repo.tasks = repo.tasks.filter((k) => k.id !== taskId)
      }),
    }),
    // The demo's worktrees are always clean (see checkTaskRemoval), so archiving never needs `force` here.
    archiveTask: (themeId, repoId, taskId) =>
      edit(themeId, (t) => {
        const task = taskIn(t, repoId, taskId)
        if (task.archivedAt !== undefined) throw new Error(`"${task.name}" is already archived`)
        task.archivedAt = new Date().toISOString()
      }),
    unarchiveTask: (themeId, repoId, taskId) =>
      edit(themeId, (t) => {
        const task = taskIn(t, repoId, taskId)
        if (task.archivedAt === undefined) throw new Error(`"${task.name}" is not archived`)
        delete task.archivedAt
      }),
    moveTask: (themeId, repoId, taskId, toIndex) =>
      edit(themeId, (t) => {
        const task = taskIn(t, repoId, taskId)
        if (task.archivedAt) throw new Error(`"${task.name}" is archived: restore it first`)
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind === 'repo') repo.tasks = [...moveActiveTask(repo.tasks, taskId, toIndex)]
      }),
    openTarget: async (target) => {
      startClaude(target, false)
      return clone(tabs)
    },
    detachTerminal: async () => {},
    listTabs: async () => clone(tabs),
    newTab: async () => clone(tabs),
    selectTab: async () => clone(tabs),
    closeTab: async () => clone(tabs),
    restartClaude: async (target, options) => {
      startClaude(target, options?.replace === true)
      return clone(tabs)
    },
    leaveCopyMode: async () => false,
    startRun: async (target) => run(target, false),
    restartRun: async (target) => run(target, true),
    // The demo's run tab "prints" Vite's address while it runs.
    getDevUrls: async () => {
      const tab = tabs.find((t) => t.name === RUN_WINDOW)
      return tab && !tab.dead ? [{ url: 'http://localhost:5173/', index: tab.index, tab: tab.name }] : []
    },
    stopRun: async () => {
      const tab = tabs.find((t) => t.name === RUN_WINDOW)
      if (tab) tab.dead = true
      return clone(tabs)
    },
    copyTranscript: async (_target, index) => transcriptOf(index).transcript,
    saveTranscript: async (_target, index) => {
      const { tab, transcript } = transcriptOf(index)
      return { path: `/home/demo/Downloads/transcript-${tab.name}.txt`, lines: transcript.lines, truncated: false }
    },
    listFiles: async () => ({ paths: [...DEMO_PATHS], truncated: false }),
    readFile: async (_target, path) => {
      const text = DEMO_FILES[path]
      if (text !== undefined) return { kind: 'text', content: text, size: new Blob([text]).size, truncated: false }
      if (path in DEMO_BINARY) return { kind: 'binary', size: DEMO_BINARY[path], mtimeMs: 0 }
      return { kind: 'missing' }
    },
    readImage: async (_target, path) => {
      if (path === 'assets/icon.png') return `data:image/png;base64,${DEMO_PNG_BASE64}`
      return path.endsWith('.svg') && DEMO_FILES[path] !== undefined
        ? `data:image/svg+xml;base64,${btoa(DEMO_FILES[path])}`
        : null
    },
    cancelSearch: async () => {},
    // The demo files, matched like main matches a folder (JavaScript patterns).
    searchFiles: async (_target, query, options) => {
      const pattern = searchPattern(checkSearchQuery(query), normalizeSearchOptions(options))
      const matches: SearchMatch[] = []
      for (const path of DEMO_PATHS) {
        const lines = DEMO_FILES[path]?.split('\n') ?? []
        for (let i = 0; i < lines.length; i++) {
          const m = pattern.exec(lines[i])
          if (!m) continue
          if (matches.length >= MAX_SEARCH_MATCHES) return { matches, truncated: true }
          matches.push(makeMatch(path, i + 1, lines[i], m.index, m[0].length))
        }
      }
      return { matches, truncated: false }
    },
    listChanges: async (target, scope = 'base') => {
      if (!target.taskId) throw new Error('Changes are only available for repository tasks')
      const changes = clone(DEMO_CHANGES)
      // The demo's uncommitted changes: a few of the files that differ from the base.
      return scope === 'uncommitted' ? { files: changes.files.slice(0, 3) } : changes
    },
    fileDiff: async (target, path) => {
      if (!target.taskId) throw new Error('Changes are only available for repository tasks')
      return DEMO_DIFFS[path] ?? ''
    },
    openInEditor: async () => {},
    openInFileManager: async () => {},
    openExternal: async () => {},
    getGitTools: async () => ({ gh: true }),
    commitAll: async (target, message) => {
      const text = message.trim()
      if (!text) throw new Error('Write a commit message first')
      if (text.length > MAX_COMMIT_MESSAGE)
        throw new Error(`The commit message is limited to ${MAX_COMMIT_MESSAGE} characters`)
      const files = (await api.listChanges(target, 'uncommitted')).files.length
      if (files === 0) throw new Error('Nothing to commit')
      return { sha: (++counter * 2654435761).toString(16).slice(-7).padStart(7, '0'), files }
    },
    pushTask: async (target) => ({ branch: taskOf(target).branch }),
    // A task named "…conflict…" always conflicts; others take the base's new commits once, then are up to date.
    updateFromBase: async (target) => {
      const task = taskOf(target)
      const { baseRef } = task
      const strategy = settings.updateStrategy
      if (/conflict/i.test(task.name))
        return { kind: 'conflict', strategy, baseRef, files: ['src/app.ts', 'src/util/format.ts'] }
      if (updated.has(task.id)) return { kind: 'upToDate', baseRef }
      updated.add(task.id)
      return { kind: 'updated', strategy, baseRef, commits: 2 }
    },
    askClaudeToResolve: async (target, _strategy, files) => {
      taskOf(target)
      if (files.length === 0) throw new Error('No conflicting files to resolve')
      return tabs
    },
    sendToClaude: async (_target, text) => {
      if (!text.trim()) throw new Error('Nothing to send to Claude')
      return tabs
    },
    createPullRequest: async (target) => {
      const task = taskOf(target)
      const created = !prs.has(task.id)
      prs.add(task.id)
      return { url: `https://github.com/demo/${task.slug}/pull/1`, created }
    },
    getUsage: async (target) => demoUsage(targetKey(target)),
    getUsageReport: async () => demoUsageReport(state),
    getBudgets: async () => demoBudgets(state, settings),
    getUsageFolders: async () =>
      profiles().map((p) => ({ profileId: p.id, name: p.name, folder: `${p.configDir}/projects` })),
    ptyWrite: () => {},
    ptyResize: () => {},
    pathForFile: (file) => `/demo/${file.name}`,
    onPtyData: () => () => {},
    onPtyExit: () => () => {},
    onSelectTarget: () => () => {},
    onBudgetAlert: () => () => {},
  }
  return { ...api, ...overrides }
}
