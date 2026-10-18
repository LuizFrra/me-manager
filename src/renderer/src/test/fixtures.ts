import type { AppState, Folder, Repo, Task, Theme } from '../../../shared/types'

/** Compact AppState builders for unit tests; ids are the names, unless given. */
export const task = (name: string, id = name): Task => ({
  id,
  name,
  slug: name,
  branch: `b/${name}`,
  worktreePath: `/wt/${name}`,
  baseRef: 'origin/main',
  createdAt: '2026-01-01T00:00:00.000Z',
})

export const repo = (name: string, tasks: Task[], id = name): Repo => ({
  id,
  kind: 'repo',
  name,
  slug: name,
  path: `/code/${name}`,
  tasks,
})

export const folder = (name: string, id = name): Folder => ({
  id,
  kind: 'folder',
  name,
  slug: name,
  path: `/f/${name}`,
})

export const theme = (name: string, items: Theme['items'], id = name): Theme => ({ id, name, slug: name, items })

export const appState = (...themes: Theme[]): AppState => ({ version: 1, themes })
