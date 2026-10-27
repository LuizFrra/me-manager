import type { AppState } from '../../shared/types'
import type { StoreApi } from '../contracts'
import { isBudget } from '../../shared/budget'
import { isRunCommand } from '../../shared/runCommand'
import { JsonFile } from './jsonFile'
import { emptyState } from './mutations'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Drops a theme's or task's `profileId` that isn't text (see checkItems). */
const dropBadProfile = (v: Record<string, unknown>): void => {
  if ('profileId' in v && typeof v.profileId !== 'string') delete v.profileId
}

/**
 * Drops an `archivedAt` that isn't a non-empty string (a hand edit), so the task loads as an active one rather
 * than as one whose archived state nothing can rely on, and a `runCommand` that isn't one line of shell as
 * setRunCommand saves it, so "Run" never starts what the app wouldn't have saved, and a task's `budgetUsd` that
 * isn't one setTaskBudget would save (the default budget then applies), and a theme's or task's `profileId` that
 * isn't text (the theme's profile, or Default, then applies). Files from before archiving, run commands, budgets or
 * profiles have none of them and load unchanged.
 */
function checkItems(state: AppState): void {
  for (const theme of state.themes) {
    if (!isRecord(theme) || !Array.isArray(theme.items)) continue
    dropBadProfile(theme)
    for (const item of theme.items as unknown[]) {
      if (isRecord(item) && 'runCommand' in item && !isRunCommand(item.runCommand)) delete item.runCommand
      if (!isRecord(item) || !Array.isArray(item.tasks)) continue
      for (const task of item.tasks as unknown[]) {
        if (!isRecord(task)) continue
        dropBadProfile(task)
        if ('budgetUsd' in task && !isBudget(task.budgetUsd)) delete task.budgetUsd
        if (!('archivedAt' in task)) continue
        if (typeof task.archivedAt !== 'string' || task.archivedAt === '') delete task.archivedAt
      }
    }
  }
}

/** The text fields every theme, item and task has had since the first state file. */
const THEME_TEXT = ['id', 'name', 'slug']
const ITEM_TEXT = ['id', 'name', 'slug', 'path']
const TASK_TEXT = ['id', 'name', 'slug', 'branch', 'worktreePath', 'baseRef', 'createdAt']

const hasText = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((k) => typeof v[k] === 'string')

/**
 * Throws, naming the first entry that isn't a theme, repo, folder or task as the app saves them (a hand edit): the
 * app would fail on it everywhere, and the window would show nothing. Only what every version saved is checked.
 */
function checkShape(themes: unknown[]): void {
  for (const [t, theme] of themes.entries()) {
    if (!isRecord(theme) || !hasText(theme, THEME_TEXT) || !Array.isArray(theme.items)) {
      throw new Error(`themes[${t}] is not a theme`)
    }
    for (const [i, item] of (theme.items as unknown[]).entries()) {
      const at = `themes[${t}].items[${i}]`
      const repo = isRecord(item) && item.kind === 'repo' && Array.isArray(item.tasks)
      if (!isRecord(item) || !hasText(item, ITEM_TEXT) || !(repo || item.kind === 'folder')) {
        throw new Error(`${at} is not a repository or folder`)
      }
      if (!repo) continue
      for (const [k, task] of (item.tasks as unknown[]).entries()) {
        if (!isRecord(task) || !hasText(task, TASK_TEXT)) throw new Error(`${at}.tasks[${k}] is not a task`)
      }
    }
  }
}

function parseState(data: unknown): AppState {
  const state = data as AppState | null
  if (state?.version !== 1 || !Array.isArray(state.themes)) throw new Error('unrecognized state format')
  checkShape(state.themes)
  checkItems(state)
  return state
}

/**
 * state.json. A corrupt file (or one that isn't a state, see checkShape) falls back to its .bak; if that is unusable
 * too, load() throws.
 */
export class FileStore implements StoreApi {
  private readonly json: JsonFile<AppState>

  constructor(file: string) {
    this.json = new JsonFile(file, parseState, emptyState)
  }

  load(): Promise<AppState> {
    return this.json.load()
  }

  save(state: AppState): Promise<void> {
    return this.json.save(state)
  }
}
