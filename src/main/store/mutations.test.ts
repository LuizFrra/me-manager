import { describe, expect, it } from 'vitest'
import type { Task } from '../../shared/types'
import * as m from './mutations'

const task = (slug: string): Task => ({
  id: `task-${slug}`,
  name: slug,
  slug,
  branch: `claude/t/${slug}`,
  worktreePath: `/wt/${slug}`,
  baseRef: 'origin/main',
  createdAt: '2026-01-01T00:00:00.000Z',
})

function setup() {
  let s = m.addTheme(m.emptyState(), 'Client X')
  const themeId = s.themes[0].id
  s = m.addRepo(s, themeId, '/code/my-api')
  const repoId = s.themes[0].items[0].id
  return { s, themeId, repoId }
}

describe('themes', () => {
  it('adds a theme with a slug', () => {
    const s = m.addTheme(m.emptyState(), 'Client X')
    expect(s.themes[0]).toMatchObject({ name: 'Client X', slug: 'client-x', items: [] })
  })
  it('rejects duplicate slugs', () => {
    const s = m.addTheme(m.emptyState(), 'Client X')
    expect(() => m.addTheme(s, 'client x')).toThrow(/already exists/)
  })
  it('rejects names without letters or numbers', () => {
    expect(() => m.addTheme(m.emptyState(), '!!!')).toThrow(/letters or numbers/)
  })
  it('does not mutate the input state', () => {
    const before = m.emptyState()
    m.addTheme(before, 'X')
    expect(before.themes).toHaveLength(0)
  })
  it('blocks removing a theme that still has tasks', () => {
    const { s, themeId, repoId } = setup()
    const withTask = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.removeTheme(withTask, themeId)).toThrow(/tasks/)
    expect(m.removeTheme(s, themeId).themes).toHaveLength(0)
  })
})

describe('items', () => {
  it('adds a repo named after the folder', () => {
    const { s } = setup()
    expect(s.themes[0].items[0]).toMatchObject({ kind: 'repo', name: 'my-api', slug: 'my-api', path: '/code/my-api', tasks: [] })
  })
  it('rejects the same path twice in one theme', () => {
    const { s, themeId } = setup()
    expect(() => m.addRepo(s, themeId, '/code/my-api')).toThrow(/already in this theme/)
  })
  it('rejects a second item with the same slug', () => {
    const { s, themeId } = setup()
    expect(() => m.addFolder(s, themeId, '/other/my-api')).toThrow(/already exists/)
  })
  it('allows the same repo in two themes', () => {
    let { s } = setup()
    s = m.addTheme(s, 'Side')
    s = m.addRepo(s, s.themes[1].id, '/code/my-api')
    expect(s.themes[1].items).toHaveLength(1)
  })
  it('adds a folder', () => {
    const { s, themeId } = setup()
    const next = m.addFolder(s, themeId, '/docs/contracts')
    expect(next.themes[0].items[1]).toMatchObject({ kind: 'folder', name: 'contracts', slug: 'contracts' })
  })
  it('blocks removing a repo with tasks', () => {
    const { s, themeId, repoId } = setup()
    const withTask = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.removeItem(withTask, themeId, repoId)).toThrow(/tasks/)
    expect(m.removeItem(s, themeId, repoId).themes[0].items).toHaveLength(0)
  })
})

describe('tasks', () => {
  it('adds and removes tasks', () => {
    const { s, themeId, repoId } = setup()
    const added = m.addTask(s, themeId, repoId, task('fix'))
    expect(m.getRepo(added, themeId, repoId).tasks).toHaveLength(1)
    const removed = m.removeTask(added, themeId, repoId, 'task-fix')
    expect(m.getRepo(removed, themeId, repoId).tasks).toHaveLength(0)
  })
  it('rejects duplicate task slugs in a repo', () => {
    const { s, themeId, repoId } = setup()
    const added = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.addTask(added, themeId, repoId, task('fix'))).toThrow(/already exists/)
  })
  it('getRepo rejects folders', () => {
    const { s, themeId } = setup()
    const next = m.addFolder(s, themeId, '/docs/notes')
    const folderId = next.themes[0].items[1].id
    expect(() => m.getRepo(next, themeId, folderId)).toThrow(/not a repository/)
  })
})
