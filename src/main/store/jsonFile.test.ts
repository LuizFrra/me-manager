import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupTempDirs, makeTempDir } from '../files/testRepos'

// Records each fsync (by path) and rename, in order, around the real calls.
const events = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const open = (async (path: string, ...rest: unknown[]) => {
    const handle = await (real.open as (...args: unknown[]) => ReturnType<typeof real.open>)(path, ...rest)
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      events.push(`sync ${path}`)
      await sync()
    }
    return handle
  }) as typeof real.open
  const rename = (async (from: string, to: string) => {
    events.push(`rename ${from} ${to}`)
    await real.rename(from, to)
  }) as typeof real.rename
  return { ...real, open, rename, default: { ...real, open, rename } }
})

import { JsonFile } from './jsonFile'

let dir: string
beforeEach(async () => {
  dir = await makeTempDir('mm-json-')
  events.length = 0
})
afterEach(cleanupTempDirs)

describe('JsonFile.save', () => {
  it('flushes the backup and the new file to disk before the rename, then the folder', async () => {
    const file = join(dir, 'state.json')
    const json = new JsonFile<{ n: number }>(
      file,
      (d) => d as { n: number },
      () => ({ n: 0 }),
    )
    await json.save({ n: 1 })
    events.length = 0
    await json.save({ n: 2 })
    const tmp = `${file}.${process.pid}.tmp`
    expect(events).toEqual([`sync ${file}.bak`, `sync ${tmp}`, `rename ${tmp} ${file}`, `sync ${dir}`])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 2 })
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual({ n: 1 })
  })
})
