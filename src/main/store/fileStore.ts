import type { AppState } from '../../shared/types'
import type { StoreApi } from '../contracts'
import { JsonFile } from './jsonFile'
import { emptyState } from './mutations'

function parseState(data: unknown): AppState {
  const state = data as AppState | null
  if (state?.version !== 1 || !Array.isArray(state.themes)) throw new Error('unrecognized state format')
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
