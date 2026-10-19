import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Vitest global setup: the whole run gets one temporary folder as TMPDIR, removed at the end, so the many
 * mkdtemp folders tests make (repos, stores, tmux sockets) can't pile up in /tmp. Workers start after this
 * runs, so they and the git and tmux processes they spawn inherit it.
 */
export default function setup(): () => void {
  const previous = process.env.TMPDIR
  const dir = mkdtempSync(join(tmpdir(), 'mmtest-'))
  process.env.TMPDIR = dir
  return () => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}
