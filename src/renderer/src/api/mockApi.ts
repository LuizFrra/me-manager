import {
  MAX_TASK_NOTES,
  type AppState,
  type MeManagerApi,
  type Settings,
  type TabInfo,
  type Theme,
} from '../../../shared/types'
import { branchName, slugify, targetKey } from '../../../shared/naming'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../../shared/settings'
import { demoUsage, demoUsageReport } from './demoUsage'
import { DEMO_BINARY, DEMO_CHANGES, DEMO_DIFFS, DEMO_FILES, DEMO_PATHS } from './demoFiles'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** The checks main makes on a new display name: trimmed, not empty, not taken (ignoring case). */
function checkName(name: string, what: string, taken: { id: string; name: string }[], selfId: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(`${what} name can't be empty`)
  if (taken.some((x) => x.id !== selfId && x.name.toLowerCase() === trimmed.toLowerCase()))
    throw new Error(`A ${what.toLowerCase()} named "${trimmed}" already exists`)
  return trimmed
}

/** In-memory MeManagerApi for tests and for running the UI in a browser. */
export function createMockApi(overrides: Partial<MeManagerApi> = {}): MeManagerApi {
  let state: AppState = { version: 1, themes: [] }
  let counter = 0
  const id = (): string => `id-${++counter}`
  const tabs: TabInfo[] = [{ index: 0, name: 'claude', active: true }]
  let settings: Settings = normalizeSettings(DEFAULT_SETTINGS)

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
    getStatus: async () => ({ running: [], missing: [] }),
    checkPrereqs: async () => ({ ok: true, missing: [] }),
    getTmuxSocket: async () => 'me-manager',
    getSettings: async () => clone(settings),
    updateSettings: async (patch) => {
      settings = normalizeSettings({ ...settings, ...patch }, settings)
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
    removeTheme: async (themeId) => {
      state = { ...state, themes: state.themes.filter((t) => t.id !== themeId) }
      return state
    },
    pickDirectory: async () => `/home/demo/project-${++counter}`,
    addRepo: (themeId, path) =>
      edit(themeId, (t) => {
        t.items.push({ id: id(), kind: 'repo', name: baseName(path), slug: slugify(baseName(path)), path, tasks: [] })
      }),
    addFolder: (themeId, path) =>
      edit(themeId, (t) => {
        t.items.push({ id: id(), kind: 'folder', name: baseName(path), slug: slugify(baseName(path)), path })
      }),
    removeItem: (themeId, itemId) =>
      edit(themeId, (t) => {
        t.items = t.items.filter((i) => i.id !== itemId)
      }),
    createTask: (themeId, repoId, name) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind !== 'repo') throw new Error('Repository not found')
        const slug = slugify(name)
        repo.tasks.push({
          id: id(),
          name,
          slug,
          branch: branchName(t.slug, slug),
          worktreePath: `/home/demo/.me-manager/worktrees/${t.slug}/${repo.slug}/${slug}`,
          baseRef: 'origin/main',
          createdAt: new Date().toISOString(),
        })
      }),
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
    checkTaskRemoval: async () => ({ uncommittedFiles: [], unpushedCommits: [] }),
    removeTask: (themeId, repoId, taskId) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind === 'repo') repo.tasks = repo.tasks.filter((k) => k.id !== taskId)
      }),
    openTarget: async () => tabs,
    listTabs: async () => tabs,
    newTab: async () => tabs,
    selectTab: async () => tabs,
    closeTab: async () => tabs,
    restartClaude: async () => tabs,
    listFiles: async () => ({ paths: [...DEMO_PATHS], truncated: false }),
    readFile: async (_target, path) => {
      const text = DEMO_FILES[path]
      if (text !== undefined) return { kind: 'text', content: text, size: new Blob([text]).size, truncated: false }
      if (path in DEMO_BINARY) return { kind: 'binary', size: DEMO_BINARY[path] }
      return { kind: 'missing' }
    },
    readImage: async (_target, path) =>
      path.endsWith('.svg') && DEMO_FILES[path] !== undefined
        ? `data:image/svg+xml;base64,${btoa(DEMO_FILES[path])}`
        : null,
    listChanges: async (target) => {
      if (!target.taskId) throw new Error('Changes are only available for repository tasks')
      return clone(DEMO_CHANGES)
    },
    fileDiff: async (target, path) => {
      if (!target.taskId) throw new Error('Changes are only available for repository tasks')
      return DEMO_DIFFS[path] ?? ''
    },
    openInEditor: async () => {},
    openInFileManager: async () => {},
    openExternal: async () => {},
    getUsage: async (target) => demoUsage(targetKey(target)),
    getUsageReport: async () => demoUsageReport(state),
    ptyWrite: () => {},
    ptyResize: () => {},
    onPtyData: () => () => {},
    onPtyExit: () => () => {},
  }
  return { ...api, ...overrides }
}
