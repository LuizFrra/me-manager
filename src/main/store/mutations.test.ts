import { describe, expect, it } from 'vitest'
import type { AppState, Task } from '../../shared/types'
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

function setup(): { s: AppState; themeId: string; repoId: string } {
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
    expect(s.themes[0].items[0]).toMatchObject({
      kind: 'repo',
      name: 'my-api',
      slug: 'my-api',
      path: '/code/my-api',
      tasks: [],
    })
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

describe('renaming', () => {
  function withTasks(): { s: AppState; themeId: string; repoId: string } {
    const { s, themeId, repoId } = setup()
    return { s: m.addTask(m.addTask(s, themeId, repoId, task('fix')), themeId, repoId, task('docs')), themeId, repoId }
  }

  it('renames a theme, trimming the name, and keeps its slug', () => {
    const { s, themeId } = setup()
    const next = m.renameTheme(s, themeId, '  Client Y  ')
    expect(next.themes[0]).toMatchObject({ name: 'Client Y', slug: 'client-x' })
    expect(s.themes[0].name).toBe('Client X') // input untouched
  })

  it('rejects an empty theme name or one another theme has, ignoring case', () => {
    const { s, themeId } = setup()
    const two = m.addTheme(s, 'Personal')
    expect(() => m.renameTheme(two, themeId, '   ')).toThrow("Theme name can't be empty")
    expect(() => m.renameTheme(two, themeId, 'PERSONAL')).toThrow('A theme named "PERSONAL" already exists')
    expect(m.renameTheme(two, themeId, 'client x').themes[0].name).toBe('client x') // its own name, new case
    expect(() => m.renameTheme(two, 'nope', 'Y')).toThrow(/Theme not found/)
  })

  it('renames a task and keeps its slug, branch and worktree path', () => {
    const { s, themeId, repoId } = withTasks()
    const next = m.renameTask(s, themeId, repoId, 'task-fix', ' Fix the login flow ')
    expect(m.getTask(next, themeId, repoId, 'task-fix')).toEqual({ ...task('fix'), name: 'Fix the login flow' })
    expect(m.getTask(s, themeId, repoId, 'task-fix').name).toBe('fix')
  })

  it('rejects an empty task name or one another task in the repo has, ignoring case', () => {
    const { s, themeId, repoId } = withTasks()
    expect(() => m.renameTask(s, themeId, repoId, 'task-fix', '')).toThrow("Task name can't be empty")
    expect(() => m.renameTask(s, themeId, repoId, 'task-fix', 'DOCS')).toThrow(
      'A task named "DOCS" already exists in my-api',
    )
    expect(m.getTask(m.renameTask(s, themeId, repoId, 'task-fix', 'FIX'), themeId, repoId, 'task-fix').name).toBe('FIX')
    expect(() => m.renameTask(s, themeId, repoId, 'nope', 'x')).toThrow(/Task not found/)
  })

  it('allows a task name used in another repo', () => {
    const { s: base, themeId, repoId } = withTasks()
    let s = m.addRepo(base, themeId, '/code/web')
    const webId = s.themes[0].items[1].id
    s = m.addTask(s, themeId, webId, { ...task('ui'), id: 'task-ui' })
    expect(m.getTask(m.renameTask(s, themeId, webId, 'task-ui', 'fix'), themeId, webId, 'task-ui').name).toBe('fix')
    expect(m.getRepo(s, themeId, repoId).tasks).toHaveLength(2)
  })

  it('keeps names unique when adding after a rename', () => {
    const { s, themeId, repoId } = withTasks()
    const renamed = m.renameTask(s, themeId, repoId, 'task-fix', 'Login')
    expect(() => m.addTask(renamed, themeId, repoId, { ...task('login'), name: 'login' })).toThrow(/already exists/)
    const theme = m.renameTheme(renamed, themeId, 'Acme')
    expect(() => m.addTheme(theme, 'ACME')).toThrow(/already exists/)
  })
})
