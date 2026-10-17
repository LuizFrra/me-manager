import type { ChangeList, FileContent } from '../../shared/types'
import type { FilesApi } from '../contracts'

/** Read-only file access for the side panel. Stub: replaced by track H. */
export class FilesService implements FilesApi {
  async listFiles(): Promise<string[]> {
    throw new Error('FilesService not implemented yet')
  }
  async readFile(): Promise<FileContent> {
    throw new Error('FilesService not implemented yet')
  }
  async readImage(): Promise<string | null> {
    throw new Error('FilesService not implemented yet')
  }
  async listChanges(): Promise<ChangeList> {
    throw new Error('FilesService not implemented yet')
  }
  async fileDiff(): Promise<string> {
    throw new Error('FilesService not implemented yet')
  }
}
