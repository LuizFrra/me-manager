import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppState } from '../../shared/types'
import type { StoreApi } from '../contracts'
import { emptyState } from './mutations'

const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

function parseState(raw: string): AppState {
  const data = JSON.parse(raw)
  if (data?.version !== 1 || !Array.isArray(data.themes)) throw new Error('unrecognized state format')
  return data as AppState
}

export class FileStore implements StoreApi {
  constructor(private readonly file: string) {}

  async load(): Promise<AppState> {
    try {
      return parseState(await readFile(this.file, 'utf8'))
    } catch (err) {
      if (isNotFound(err)) return emptyState()
      try {
        return parseState(await readFile(this.file + '.bak', 'utf8'))
      } catch {
        throw new Error(`Could not read ${this.file}: ${(err as Error).message}`)
      }
    }
  }

  async save(state: AppState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    try {
      await copyFile(this.file, this.file + '.bak')
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }
}
