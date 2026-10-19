import type { AppState } from '../../shared/types'
import type { StoreApi } from '../contracts'
import { isBudget } from '../../shared/budget'
import { isRunCommand } from '../../shared/runCommand'
import { JsonFile } from './jsonFile'
import { emptyState } from './mutations'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Drops an `archivedAt` that isn't a non-empty string (a hand edit), so the task loads as an active one rather
 * than as one whose archived state nothing can rely on, and a `runCommand` that isn't one line of shell as
 * setRunCommand saves it, so "Run" never starts what the app wouldn't have saved, and a task's `budgetUsd` that
 * isn't one setTaskBudget would save (the default budget then applies). Files from before archiving, run commands
 * or budgets have none of them and load unchanged.
 */
function checkItems(state: AppState): void {
  for (const theme of state.themes) {
    if (!isRecord(theme) || !Array.isArray(theme.items)) continue
    for (const item of theme.items as unknown[]) {
      if (isRecord(item) && 'runCommand' in item && !isRunCommand(item.runCommand)) delete item.runCommand
      if (!isRecord(item) || !Array.isArray(item.tasks)) continue
      for (const task of item.tasks as unknown[]) {
        if (!isRecord(task)) continue
        if ('budgetUsd' in task && !isBudget(task.budgetUsd)) delete task.budgetUsd
        if (!('archivedAt' in task)) continue
        if (typeof task.archivedAt !== 'string' || task.archivedAt === '') delete task.archivedAt
      }
    }
  }
}

function parseState(data: unknown): AppState {
  const state = data as AppState | null
  if (state?.version !== 1 || !Array.isArray(state.themes)) throw new Error('unrecognized state format')
  checkItems(state)
  return state
}

/** state.json. A corrupt file falls back to its .bak; if that is unreadable too, load() throws. */
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
