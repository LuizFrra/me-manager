import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote } from '../shared/shell'
import type { PromptFilesApi } from './contracts'

/**
 * How long a prompt file is kept after the tmux command that reads it started: the shell reads it as the window
 * starts (before Claude does), so this only needs to cover a slow shell start-up (heavy rc files, a busy machine).
 */
export const PROMPT_FILE_GRACE_MS = 60_000

/**
 * The shell word that expands to a prompt file's contents: one double-quoted command substitution, so the text is
 * never split, globbed or run, whatever it holds. Only the path is in the command, shell-quoted. (`$(…)` drops
 * trailing newlines only; a prompt's trailing space, see promptArgument, stays.)
 */
export const promptFromFile = (path: string): string => `"$(cat -- ${shellQuote(path)})"`

/**
 * Prompts handed to `claude` in a tmux window through private files instead of the command line, which tmux caps
 * at ~16 KB (quoting and multi-byte text inflate a 10,000-character prompt past it). Each file is new (`wx`), named
 * at random and readable by the user only, in a folder only the user can open.
 */
export class PromptFiles implements PromptFilesApi {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly dir: string,
    private readonly graceMs = PROMPT_FILE_GRACE_MS,
  ) {}

  async write(text: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700) // mkdir's mode doesn't apply to a folder that already existed
    const path = join(this.dir, `prompt-${randomUUID()}.txt`)
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return path
  }

  release(path: string, immediately = false): void {
    const remove = (): void => void unlink(path).catch(() => {})
    if (immediately) return remove()
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      remove()
    }, this.graceMs)
    timer.unref?.()
    this.timers.add(timer)
  }

  /** Removes prompt files left behind by an earlier run (one that quit before their grace time was up). */
  async sweep(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return // no folder yet
    }
    const now = Date.now()
    await Promise.all(
      names
        .filter((name) => /^prompt-[0-9a-f-]+\.txt$/.test(name))
        .map(async (name) => {
          const path = join(this.dir, name)
          const s = await stat(path).catch(() => null)
          if (s && now - s.mtimeMs >= this.graceMs) await unlink(path).catch(() => {})
        }),
    )
  }
}
