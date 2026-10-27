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
  it('round-trips task budgets and drops one that does not check out, so the task loads without it', async () => {
    const tasks = [5, 2.5, 0, -1, '5', 4.567, 1e9].map((budgetUsd, i) => ({
      id: `k${i}`,
      name: `t${i}`,
      slug: `t${i}`,
      branch: `b/t${i}`,
      worktreePath: `/wt/t${i}`,
      baseRef: 'origin/main',
      createdAt: '2026-01-01T00:00:00.000Z',
      budgetUsd,
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
    const repo = (await new FileStore(file).load()).themes[0].items[0]
    const loaded = repo.kind === 'repo' ? repo.tasks : []
    expect(loaded.map((t) => t.budgetUsd)).toEqual([5, 2.5, undefined, undefined, undefined, undefined, undefined])
    expect(loaded.map((t) => 'budgetUsd' in t)).toEqual([true, true, false, false, false, false, false])
  })
  it('round-trips run commands and drops one that does not check out, so the item loads without it', async () => {
    const raw = {
      version: 1,
      themes: [
        {
          id: 't1',
          name: 'X',
          slug: 'x',
          items: [
            { id: 'r1', kind: 'repo', name: 'a', slug: 'a', path: '/a', tasks: [], runCommand: 'npm run dev' },
            { id: 'f1', kind: 'folder', name: 'b', slug: 'b', path: '/b', runCommand: 'hugo server' },
            { id: 'r2', kind: 'repo', name: 'c', slug: 'c', path: '/c', tasks: [], runCommand: 'a\nb' },
            { id: 'f2', kind: 'folder', name: 'd', slug: 'd', path: '/d', runCommand: 42 },
            { id: 'f3', kind: 'folder', name: 'e', slug: 'e', path: '/e', runCommand: '' },
          ],
        },
      ],
    }
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify(raw), 'utf8')
    const items = (await new FileStore(file).load()).themes[0].items
    expect(items.map((i) => i.runCommand)).toEqual(['npm run dev', 'hugo server', undefined, undefined, undefined])
    expect(items.map((i) => 'runCommand' in i)).toEqual([true, true, false, false, false])
  })
  it('round-trips the Claude profiles of themes and tasks, and drops one that is not text', async () => {
    const task = {
      id: 'k1',
      name: 'fix',
      slug: 'fix',
      branch: 'b/fix',
      worktreePath: '/wt/fix',
      baseRef: 'origin/main',
      createdAt: '2026-01-01T00:00:00.000Z',
      profileId: 'p-home',
    }
    const state = {
      version: 1 as const,
      themes: [
        {
          id: 't1',
          name: 'X',
          slug: 'x',
          profileId: 'p-work',
          items: [{ id: 'r1', kind: 'repo' as const, name: 'a', slug: 'a', path: '/a', tasks: [task] }],
        },
      ],
    }
    await new FileStore(file).save(state)
    await expect(new FileStore(file).load()).resolves.toEqual(state)
    // A hand edit: the theme and task load without it, in Default and in their theme's profile.
    const [t] = state.themes
    const edited = {
      ...state,
      themes: [
        {
          ...t,
          profileId: 7,
          items: [
            {
              ...t.items[0],
              tasks: [
                { ...task, profileId: null },
                { ...task, id: 'k2', profileId: '' },
              ],
            },
          ],
        },
      ],
    }
    await writeFile(file, JSON.stringify(edited), 'utf8')
    const loaded = (await new FileStore(file).load()).themes[0]
    expect(loaded).not.toHaveProperty('profileId')
    const tasks = loaded.items[0].kind === 'repo' ? loaded.items[0].tasks : []
    expect(tasks.map((k) => k.id)).toEqual(['k1', 'k2'])
    expect(tasks.map((k) => 'profileId' in k)).toEqual([false, false])
  })
  it('falls back to .bak when the main file is JSON but not a state the app saves (a hand edit)', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    const theme = { id: 't', name: 'X', slug: 'x' }
    const item = { id: 'r', kind: 'repo', name: 'a', slug: 'a', path: '/a' }
    for (const broken of [
      { version: 1, themes: [null] },
      { version: 1, themes: [theme] }, // no items
      { version: 1, themes: [{ ...theme, items: [item] }] }, // a repo without tasks
      { version: 1, themes: [{ ...theme, items: [{ ...item, kind: 'thing', tasks: [] }] }] },
      { version: 1, themes: [{ ...theme, items: [{ ...item, path: 7, tasks: [] }] }] },
      { version: 1, themes: [{ ...theme, items: [{ ...item, tasks: [{ id: 'k', name: 'fix', slug: 'fix' }] }] }] },
    ]) {
      await writeFile(file, JSON.stringify(broken), 'utf8')
      await expect(new FileStore(file).load()).resolves.toEqual(first)
    }
  })
  it('says what is wrong when the backup is no state either', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    const broken = { version: 1, themes: [{ id: 't', name: 'X', slug: 'x', items: [{ id: 'f', kind: 'folder' }] }] }
    await writeFile(file, JSON.stringify(broken), 'utf8')
    await writeFile(file + '.bak', JSON.stringify(broken), 'utf8')
    await expect(new FileStore(file).load()).rejects.toThrow(
      `Could not read ${file}: themes[0].items[0] is not a repository or folder`,
    )
  })
  it('throws when both files are unreadable', async () => {
    const store = new FileStore(file)
    await store.save(emptyState())
    await writeFile(file, 'garbage', 'utf8')
    await expect(store.load()).rejects.toThrow(/Could not read/)
  })
})
