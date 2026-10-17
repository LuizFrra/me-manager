import type { AppState, MeManagerApi, TabInfo, Theme } from '../../../shared/types'
import { branchName, slugify } from '../../../shared/naming'
import { DEMO_BINARY, DEMO_CHANGES, DEMO_DIFFS, DEMO_FILES, DEMO_PATHS } from './demoFiles'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** In-memory MeManagerApi for tests and for running the UI in a browser. */
export function createMockApi(overrides: Partial<MeManagerApi> = {}): MeManagerApi {
  let state: AppState = { version: 1, themes: [] }
  let counter = 0
  const id = (): string => `id-${++counter}`
  const tabs: TabInfo[] = [{ index: 0, name: 'claude', active: true }]

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
    createTheme: async (name) => {
      state = { ...state, themes: [...state.themes, { id: id(), name, slug: slugify(name), items: [] }] }
      return state
    },
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
    listFiles: async () => [...DEMO_PATHS],
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
    openExternal: async () => {},
    ptyWrite: () => {},
    ptyResize: () => {},
    onPtyData: () => () => {},
    onPtyExit: () => () => {},
  }
  return { ...api, ...overrides }
}
