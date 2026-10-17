import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AppState, Folder, Item, Repo, Task, Theme } from '../../shared/types'
import { slugify } from '../../shared/naming'

export function emptyState(): AppState {
  return { version: 1, themes: [] }
}

function clone(state: AppState): AppState {
  return structuredClone(state)
}

export function requireSlug(name: string, what: string): string {
  const slug = slugify(name)
  if (!slug) throw new Error(`${what} name "${name}" must contain letters or numbers`)
  return slug
}

export function getTheme(state: AppState, themeId: string): Theme {
  const theme = state.themes.find((t) => t.id === themeId)
  if (!theme) throw new Error(`Theme not found: ${themeId}`)
  return theme
}

export function getItem(state: AppState, themeId: string, itemId: string): Item {
  const item = getTheme(state, themeId).items.find((i) => i.id === itemId)
  if (!item) throw new Error(`Item not found: ${itemId}`)
  return item
}

export function getRepo(state: AppState, themeId: string, repoId: string): Repo {
  const item = getItem(state, themeId, repoId)
  if (item.kind !== 'repo') throw new Error(`"${item.name}" is not a repository`)
  return item
}

export function getTask(state: AppState, themeId: string, repoId: string, taskId: string): Task {
  const task = getRepo(state, themeId, repoId).tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return task
}

export function assertTaskSlugFree(repo: Repo, slug: string): void {
  if (repo.tasks.some((t) => t.slug === slug)) {
    throw new Error(`A task named "${slug}" already exists in ${repo.name}`)
  }
}

export function addTheme(state: AppState, name: string): AppState {
  const slug = requireSlug(name, 'Theme')
  if (state.themes.some((t) => t.slug === slug)) throw new Error(`A theme named "${name.trim()}" already exists`)
  const next = clone(state)
  next.themes.push({ id: randomUUID(), name: name.trim(), slug, items: [] })
  return next
}

export function removeTheme(state: AppState, themeId: string): AppState {
  const theme = getTheme(state, themeId)
  if (theme.items.some((i) => i.kind === 'repo' && i.tasks.length > 0)) {
    throw new Error(`Remove the tasks in "${theme.name}" first`)
  }
  const next = clone(state)
  next.themes = next.themes.filter((t) => t.id !== themeId)
  return next
}

function addItem(state: AppState, themeId: string, item: Repo | Folder): AppState {
  const theme = getTheme(state, themeId)
  if (theme.items.some((i) => i.path === item.path)) throw new Error(`${item.path} is already in this theme`)
  if (theme.items.some((i) => i.slug === item.slug)) {
    throw new Error(`An item named "${item.name}" already exists in this theme`)
  }
  const next = clone(state)
  getTheme(next, themeId).items.push(item)
  return next
}

export function addRepo(state: AppState, themeId: string, repoPath: string): AppState {
  const name = basename(repoPath)
  return addItem(state, themeId, {
    id: randomUUID(),
    kind: 'repo',
    name,
    slug: requireSlug(name, 'Repository'),
    path: repoPath,
    tasks: [],
  })
}

export function addFolder(state: AppState, themeId: string, folderPath: string): AppState {
  const name = basename(folderPath)
  return addItem(state, themeId, {
    id: randomUUID(),
    kind: 'folder',
    name,
    slug: requireSlug(name, 'Folder'),
    path: folderPath,
  })
}

export function removeItem(state: AppState, themeId: string, itemId: string): AppState {
  const item = getItem(state, themeId, itemId)
  if (item.kind === 'repo' && item.tasks.length > 0) throw new Error(`Remove the tasks in "${item.name}" first`)
  const next = clone(state)
  const theme = getTheme(next, themeId)
  theme.items = theme.items.filter((i) => i.id !== itemId)
  return next
}

export function addTask(state: AppState, themeId: string, repoId: string, task: Task): AppState {
  assertTaskSlugFree(getRepo(state, themeId, repoId), task.slug)
  const next = clone(state)
  getRepo(next, themeId, repoId).tasks.push(task)
  return next
}

export function removeTask(state: AppState, themeId: string, repoId: string, taskId: string): AppState {
  getTask(state, themeId, repoId, taskId)
  const next = clone(state)
  const repo = getRepo(next, themeId, repoId)
  repo.tasks = repo.tasks.filter((t) => t.id !== taskId)
  return next
}
