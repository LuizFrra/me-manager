import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Flushes a file, or a folder's entries, to disk: a rename can reach the disk before the data it points to. */
async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * A JSON file written atomically (temp file + rename) that keeps the previous version as `<file>.bak`.
 * `parse` validates the parsed JSON and throws if it is unusable.
 */
export class JsonFile<T> {
  /** Set when load() found the main file corrupt: it must not replace the (possibly good) backup. */
  private skipNextBackup = false

  constructor(
    readonly file: string,
    private readonly parse: (data: unknown) => T,
    private readonly empty: () => T,
  ) {}

  /** `empty()` when the file doesn't exist; the .bak when it is corrupt; throws when both are unreadable. */
  async load(): Promise<T> {
    try {
      return this.parse(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (err) {
      if (isNotFound(err)) return this.empty()
      this.skipNextBackup = true
      try {
        return this.parse(JSON.parse(await readFile(this.file + '.bak', 'utf8')))
      } catch {
        throw new Error(`Could not read ${this.file}: ${(err as Error).message}`)
      }
    }
  }

  /** Not safe to call concurrently: callers serialize their saves. */
  async save(value: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    if (!this.skipNextBackup) {
      try {
        await copyFile(this.file, this.file + '.bak')
        await syncPath(this.file + '.bak')
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
    }
    const tmp = `${this.file}.${process.pid}.tmp`
    // Flushed before the rename: after a power loss the file is then the old or the new version, never empty.
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.file)
    // So the rename itself survives one; best effort, as not every system can open a folder.
    await syncPath(dirname(this.file)).catch(() => {})
    this.skipNextBackup = false
  }
}
