import { emptyUiState } from '../../shared/uiState'
import type { UiState } from '../../shared/types'
import { JsonFile } from './jsonFile'

/** Where the UI state is kept. The contents are checked by the orchestrator (normalizeUiState), not here. */
export interface UiStateStoreApi {
  /** What was saved last, unchecked; an empty UI state when there is nothing (usable) on disk. */
  load(): Promise<unknown>
  save(state: UiState): Promise<void>
}

/**
 * ui-state.json, next to state.json: what the UI looked like when it was left. Kept in main rather than in the
 * renderer's localStorage, which can be wiped. Never fails to load (a corrupt file gives its .bak, or nothing:
 * the UI is not worth refusing to start over), and saves one at a time, as JsonFile needs.
 */
export class UiStateStore implements UiStateStoreApi {
  private readonly json: JsonFile<unknown>
  private queue: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.json = new JsonFile<unknown>(
      file,
      (data) => {
        if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Not a UI state')
        return data
      },
      emptyUiState,
    )
  }

  async load(): Promise<unknown> {
    try {
      return await this.json.load()
    } catch {
      return emptyUiState()
    }
  }

  save(state: UiState): Promise<void> {
    const run = this.queue.then(() => this.json.save(state))
    this.queue = run.catch(() => {})
    return run
  }
}
