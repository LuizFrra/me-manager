import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../../shared/types'
import { FileStore } from './fileStore'
import { addTheme, emptyState } from './mutations'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-store-'))
  file = join(dir, 'nested', 'state.json')
})

describe('FileStore', () => {
  it('returns empty state when the file does not exist', async () => {
    await expect(new FileStore(file).load()).resolves.toEqual(emptyState())
  })
  it('round-trips state', async () => {
    const store = new FileStore(file)
    const state = addTheme(emptyState(), 'Client X')
    await store.save(state)
    await expect(store.load()).resolves.toEqual(state)
  })
  it('keeps the previous version as .bak', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(first)
  })
  it('falls back to .bak when the main file is corrupt', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    await writeFile(file, '{ not json', 'utf8')
    await expect(store.load()).resolves.toEqual(first)
  })
  it('does not overwrite the good .bak with the corrupt main file after falling back', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    await writeFile(file, '{ not json', 'utf8')
    const loaded = await store.load()
    const next = addTheme(loaded, 'Three')
    await store.save(next)
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(first)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(next)
    // Only that one save skips the backup.
    await store.save(addTheme(next, 'Four'))
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(next)
  })
  it('loads a state file from before archiving unchanged, and round-trips an archived task', async () => {
    const task = {
      id: 'k1',
      name: 'fix',
      slug: 'fix',
      branch: 'claude/client-x/fix',
      worktreePath: '/wt/client-x/api/fix',
      baseRef: 'origin/main',
      createdAt: '2026-01-01T00:00:00.000Z',
      notes: 'wip',
    }
    const old = {
      version: 1,
      themes: [
        {
          id: 't1',
          name: 'Client X',
          slug: 'client-x',
          items: [{ id: 'r1', kind: 'repo', name: 'api', slug: 'api', path: '/code/api', tasks: [task] }],
        },
      ],
    }
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify(old), 'utf8')
    const store = new FileStore(file)
    await expect(store.load()).resolves.toEqual(old)
    const archived = structuredClone(old) as AppState
    const repo = archived.themes[0].items[0]
    if (repo.kind === 'repo') repo.tasks[0].archivedAt = '2026-02-01T10:00:00.000Z'
    await store.save(archived)
    await expect(new FileStore(file).load()).resolves.toEqual(archived)
  })
  it('drops an archivedAt that is not a time, so the task loads as active', async () => {
    const tasks = [null, 5, '', ['x']].map((archivedAt, i) => ({
      id: `k${i}`,
      name: `t${i}`,
      slug: `t${i}`,
      branch: `b/t${i}`,
      worktreePath: `/wt/t${i}`,
      baseRef: 'origin/main',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt,
    }))
    const raw = {
      version: 1,
      themes: [
        {
          id: 't1',
          name: 'X',
          slug: 'x',
          items: [{ id: 'r1', kind: 'repo', name: 'a', slug: 'a', path: '/a', tasks }],
        },
      ],
    }
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify(raw), 'utf8')
    const loaded = await new FileStore(file).load()
    const repo = loaded.themes[0].items[0]
    expect(repo.kind === 'repo' && repo.tasks.map((t) => 'archivedAt' in t)).toEqual([false, false, false, false])
  })
  it('throws when both files are unreadable', async () => {
    const store = new FileStore(file)
    await store.save(emptyState())
    await writeFile(file, 'garbage', 'utf8')
    await expect(store.load()).rejects.toThrow(/Could not read/)
  })
})
