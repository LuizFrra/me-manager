import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import {
  isArchived,
  MAX_TASK_NOTES,
  type AppState,
  type Folder,
  type Item,
  type Repo,
  type Task,
  type Theme,
} from '../../shared/types'
import { slugify } from '../../shared/naming'
import { isThemeColor, normalizeThemeStyle, themeIconError } from '../../shared/themeStyle'
import { isRunCommand, normalizeRunCommand } from '../../shared/runCommand'
import { clampIndex, moveActiveTask, moveEntry } from '../../shared/reorder'
import { normalizeBudget } from '../../shared/budget'

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

/** " (archived)" for a task that is, so a clash with a task the sidebar tucks away is not a mystery. */
const archivedNote = (task: Task): string => (isArchived(task) ? ' (archived)' : '')

/** Archived tasks count too: their branch and worktree path are still theirs. */
export function assertTaskSlugFree(repo: Repo, slug: string): void {
  const clash = repo.tasks.find((t) => t.slug === slug)
  if (clash) throw new Error(`A task named "${slug}" already exists in ${repo.name}${archivedNote(clash)}`)
}

/** Display names are unique (ignoring case) among themes, and among the tasks of one repo. */
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The trimmed display name; throws if it is empty. */
export function requireName(name: string, what: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(`${what} name can't be empty`)
  return trimmed
}

/** `exceptId`: the task being renamed, which may keep its own name. */
export function assertTaskNameFree(repo: Repo, name: string, exceptId?: string): void {
  const clash = repo.tasks.find((t) => t.id !== exceptId && sameName(t.name, name))
  if (clash) throw new Error(`A task named "${name.trim()}" already exists in ${repo.name}${archivedNote(clash)}`)
}

function assertThemeNameFree(state: AppState, name: string, exceptId?: string): void {
  if (state.themes.some((t) => t.id !== exceptId && sameName(t.name, name))) {
    throw new Error(`A theme named "${name.trim()}" already exists`)
  }
}

export function addTheme(state: AppState, name: string): AppState {
  const slug = requireSlug(name, 'Theme')
  if (state.themes.some((t) => t.slug === slug)) throw new Error(`A theme named "${name.trim()}" already exists`)
  assertThemeNameFree(state, name)
  const next = clone(state)
  next.themes.push({ id: randomUUID(), name: name.trim(), slug, items: [] })
  return next
}

/** Changes the display name only: the slug, and so branches, worktree paths and sessions, stay as they are. */
export function renameTheme(state: AppState, themeId: string, name: string): AppState {
  getTheme(state, themeId)
  const trimmed = requireName(name, 'Theme')
  assertThemeNameFree(state, trimmed, themeId)
  const next = clone(state)
  getTheme(next, themeId).name = trimmed
  return next
}

/**
 * Sets a theme's colour and icon from an untrusted style (see normalizeThemeStyle): a field left out removes it.
 * Throws on an unknown colour or an icon that is not a single emoji.
 */
export function customizeTheme(state: AppState, themeId: string, raw: unknown): AppState {
  getTheme(state, themeId)
  const style = normalizeThemeStyle(raw)
  const next = clone(state)
  const theme = getTheme(next, themeId)
  delete theme.color
  delete theme.icon
  if (style.color) theme.color = style.color
  if (style.icon) theme.icon = style.icon
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('\0')
/** A slug as slugify makes it, so a restored one can't smuggle `/`, `..` or `_` into paths and session names. */
const isSlug = (v: unknown): v is string => typeof v === 'string' && v !== '' && slugify(v) === v

/** Every theme, item and task id in the state. */
function allIds(state: AppState): Set<string> {
  const ids = new Set<string>()
  for (const theme of state.themes) {
    ids.add(theme.id)
    for (const item of theme.items) {
      ids.add(item.id)
      if (item.kind === 'repo') for (const task of item.tasks) ids.add(task.id)
    }
  }
  return ids
}

/**
 * A removed theme or item as sent back for an undo (so not trusted): only the known fields, checked. A repo comes
 * back without tasks, since one with tasks can't be removed. A run command that doesn't check out is dropped.
 */
function restoredItem(raw: unknown): Item {
  if (!isRecord(raw) || (raw.kind !== 'repo' && raw.kind !== 'folder')) throw new Error('Invalid item to restore')
  const { id, name, slug, path } = raw
  if (!isText(id) || !isText(name) || !isSlug(slug) || !isText(path) || !isAbsolute(path)) {
    throw new Error('Invalid item to restore')
  }
  const run = isRunCommand(raw.runCommand) ? { runCommand: raw.runCommand } : {}
  if (raw.kind === 'folder') return { id, kind: 'folder', name, slug, path, ...run }
  if (raw.tasks !== undefined && !(Array.isArray(raw.tasks) && raw.tasks.length === 0)) {
    throw new Error(`"${name}" can't be restored with tasks`)
  }
  return { id, kind: 'repo', name, slug, path, tasks: [], ...run }
}

/** Where a restored entry goes: its old position when given (clamped), otherwise the end. */
const insertAt = <T>(list: T[], entry: T, index?: number): void => {
  const at =
    typeof index === 'number' && Number.isInteger(index) ? Math.min(Math.max(index, 0), list.length) : list.length
  list.splice(at, 0, entry)
}

/**
 * Undoes removeItem: puts the item back into its theme with the same id, name, slug and path, at `index` if
 * given. Rejects it when its id is in use anywhere, or its path or slug is in the theme meanwhile.
 */
export function restoreItem(state: AppState, themeId: string, raw: unknown, index?: number): AppState {
  const item = restoredItem(raw)
  const theme = getTheme(state, themeId)
  if (allIds(state).has(item.id)) throw new Error(`"${item.name}" is already in me-manager`)
  if (theme.items.some((i) => i.path === item.path)) throw new Error(`${item.path} is already in this theme`)
  if (theme.items.some((i) => i.slug === item.slug)) {
    throw new Error(`An item named "${item.name}" already exists in this theme`)
  }
  const next = clone(state)
  insertAt(getTheme(next, themeId).items, item, index)
  return next
}

/**
 * Undoes removeTheme: puts the theme back with its items, ids, names, slugs, paths and style, at `index` if given.
 * Rejects it when an id is in use, its slug or name is taken by another theme meanwhile, or its items clash.
 */
export function restoreTheme(state: AppState, raw: unknown, index?: number): AppState {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw new Error('Invalid theme to restore')
  const { id, name, slug } = raw
  if (!isText(id) || !isText(name) || !isSlug(slug)) throw new Error('Invalid theme to restore')
  const items = raw.items.map(restoredItem)
  const ids = allIds(state)
  const own = new Set<string>()
  for (const entry of [id, ...items.map((i) => i.id)]) {
    if (ids.has(entry) || own.has(entry)) throw new Error(`"${name}" is already in me-manager`)
    own.add(entry)
  }
  if (state.themes.some((t) => t.slug === slug) || state.themes.some((t) => sameName(t.name, name))) {
    throw new Error(`A theme named "${name.trim()}" already exists`)
  }
  if (new Set(items.map((i) => i.path)).size < items.length || new Set(items.map((i) => i.slug)).size < items.length) {
    throw new Error(`Invalid theme to restore: "${name}" lists an item twice`)
  }
  // The style comes back too; one that doesn't check out (a hand-edited state) is dropped, not refused.
  const theme: Theme = { id, name, slug, items }
  if (isThemeColor(raw.color)) theme.color = raw.color
  if (typeof raw.icon === 'string' && raw.icon.trim() && themeIconError(raw.icon) === null) theme.icon = raw.icon.trim()
  const next = clone(state)
  insertAt(next.themes, theme, index)
  return next
}

/**
 * Sets a repo's or folder's run command from untrusted input (see normalizeRunCommand), trimmed; empty removes it.
 * Throws on a multi-line or over-long command.
 */
export function setRunCommand(state: AppState, themeId: string, itemId: string, command: unknown): AppState {
  getItem(state, themeId, itemId)
  const runCommand = normalizeRunCommand(command)
  const next = clone(state)
  const item = getItem(next, themeId, itemId)
  if (runCommand) item.runCommand = runCommand
  else delete item.runCommand
  return next
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
  const repo = getRepo(state, themeId, repoId)
  assertTaskSlugFree(repo, task.slug)
  assertTaskNameFree(repo, task.name)
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

/** Marks a task archived at `archivedAt` (ISO time); everything else about it is kept. */
export function archiveTask(
  state: AppState,
  themeId: string,
  repoId: string,
  taskId: string,
  archivedAt: string,
): AppState {
  const task = getTask(state, themeId, repoId, taskId)
  if (isArchived(task)) throw new Error(`"${task.name}" is already archived`)
  const next = clone(state)
  getTask(next, themeId, repoId, taskId).archivedAt = archivedAt
  return next
}

/** Makes an archived task active again. */
export function unarchiveTask(state: AppState, themeId: string, repoId: string, taskId: string): AppState {
  const task = getTask(state, themeId, repoId, taskId)
  if (!isArchived(task)) throw new Error(`"${task.name}" is not archived`)
  const next = clone(state)
  delete getTask(next, themeId, repoId, taskId).archivedAt
  return next
}

/** Changes the display name only: the slug, branch, worktree path and tmux session stay as they are. */
export function renameTask(state: AppState, themeId: string, repoId: string, taskId: string, name: string): AppState {
  getTask(state, themeId, repoId, taskId)
  const trimmed = requireName(name, 'Task')
  assertTaskNameFree(getRepo(state, themeId, repoId), trimmed, taskId)
  const next = clone(state)
  getTask(next, themeId, repoId, taskId).name = trimmed
  return next
}

/** Sets a task's notes, trimmed; empty (or only whitespace) removes them. */
export function setTaskNotes(
  state: AppState,
  themeId: string,
  repoId: string,
  taskId: string,
  notes: string,
): AppState {
  getTask(state, themeId, repoId, taskId)
  if (typeof notes !== 'string') throw new Error('Notes must be text')
  const trimmed = notes.trim()
  if (trimmed.length > MAX_TASK_NOTES) {
    throw new Error(`Notes are limited to ${MAX_TASK_NOTES} characters (got ${trimmed.length})`)
  }
  const next = clone(state)
  const task = getTask(next, themeId, repoId, taskId)
  if (trimmed) task.notes = trimmed
  else delete task.notes
  return next
}

/** A position to move to, from the renderer: any integer, clamped by the move. */
function checkIndex(index: unknown): number {
  if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('Invalid position to move to')
  return index
}

/** Moves the theme to index `toIndex` (clamped) among the themes. The same state when it is already there. */
export function moveTheme(state: AppState, themeId: string, toIndex: number): AppState {
  const to = checkIndex(toIndex)
  const from = state.themes.indexOf(getTheme(state, themeId))
  if (clampIndex(to, state.themes.length) === from) return state
  const next = clone(state)
  next.themes = [...moveEntry(next.themes, from, to)]
  return next
}

/**
 * Moves a repo or folder to index `toIndex` (clamped) within its theme; never to another theme, as its tasks'
 * worktree paths hold the theme's slug. The same state when it is already there.
 */
export function moveItem(state: AppState, themeId: string, itemId: string, toIndex: number): AppState {
  const to = checkIndex(toIndex)
  const { items } = getTheme(state, themeId)
  const from = items.indexOf(getItem(state, themeId, itemId))
  if (clampIndex(to, items.length) === from) return state
  const next = clone(state)
  const theme = getTheme(next, themeId)
  theme.items = [...moveEntry(theme.items, from, to)]
  return next
}

/**
 * Moves an active task to position `toIndex` (clamped) among its repo's active tasks, as the sidebar lists them;
 * archived tasks keep their slots. Refused for an archived task. The same state when it is already there.
 */
export function moveTask(state: AppState, themeId: string, repoId: string, taskId: string, toIndex: number): AppState {
  const to = checkIndex(toIndex)
  const task = getTask(state, themeId, repoId, taskId)
  if (isArchived(task)) throw new Error(`"${task.name}" is archived: restore it first`)
  const { tasks } = getRepo(state, themeId, repoId)
  if (moveActiveTask(tasks, taskId, to) === tasks) return state
  const next = clone(state)
  const repo = getRepo(next, themeId, repoId)
  repo.tasks = [...moveActiveTask(repo.tasks, taskId, to)]
  return next
}

/** Sets a task's own budget from untrusted input (see normalizeBudget), in cents; null removes it. */
export function setTaskBudget(
  state: AppState,
  themeId: string,
  repoId: string,
  taskId: string,
  budgetUsd: unknown,
): AppState {
  getTask(state, themeId, repoId, taskId)
  const budget = normalizeBudget(budgetUsd)
  const next = clone(state)
  const task = getTask(next, themeId, repoId, taskId)
  if (budget === null) delete task.budgetUsd
  else task.budgetUsd = budget
  return next
}
