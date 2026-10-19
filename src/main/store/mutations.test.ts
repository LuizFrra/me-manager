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

describe('theme style', () => {
  it('sets and replaces a colour and an icon, without touching the input', () => {
    const { s, themeId } = setup()
    const styled = m.customizeTheme(s, themeId, { color: 'purple', icon: ' 🚀 ' })
    expect(styled.themes[0]).toMatchObject({ name: 'Client X', slug: 'client-x', color: 'purple', icon: '🚀' })
    expect(s.themes[0].color).toBeUndefined()
    const recoloured = m.customizeTheme(styled, themeId, { color: 'green' })
    expect(recoloured.themes[0].color).toBe('green')
    expect(recoloured.themes[0]).not.toHaveProperty('icon') // left out: removed
    expect(m.customizeTheme(recoloured, themeId, { color: '', icon: '' }).themes[0]).not.toHaveProperty('color')
  })

  it('rejects unknown colours, raw CSS, text and several emoji as an icon, and unknown themes', () => {
    const { s, themeId } = setup()
    for (const [style, error] of [
      [{ color: 'chartreuse' }, /Unknown theme colour/],
      [{ color: '#ff0000' }, /Unknown theme colour/],
      [{ color: 'red; background: url(x)' }, /Unknown theme colour/],
      [{ icon: 'X' }, 'Use an emoji, not a letter or symbol'],
      [{ icon: '🚀🔥' }, 'Use a single emoji'],
      [{ icon: '👨‍👩‍👧‍👦' }, 'Use a single emoji'],
      [{ icon: 5 }, 'The icon must be an emoji'],
      ['blue', 'Invalid theme style'],
    ] as const)
      expect(() => m.customizeTheme(s, themeId, style)).toThrow(error)
    expect(() => m.customizeTheme(s, 'nope', { color: 'blue' })).toThrow(/Theme not found/)
  })

  it('keeps the style when a removed theme is restored, dropping a style that does not check out', () => {
    const { s, themeId } = setup()
    const styled = m.customizeTheme(s, themeId, { color: 'red', icon: '🔥' })
    const theme = styled.themes[0]
    const removed = m.removeTheme(styled, themeId)
    expect(m.restoreTheme(removed, theme).themes[0]).toEqual(theme)
    const bad = m.restoreTheme(removed, { ...theme, color: '#f00', icon: 'not an emoji' }).themes[0]
    expect(bad).not.toHaveProperty('color')
    expect(bad).not.toHaveProperty('icon')
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

describe('restoring a removed item or theme (undo)', () => {
  function withFolder(): { s: AppState; themeId: string; repoId: string; folderId: string } {
    const { s: base, themeId, repoId } = setup()
    const s = m.addFolder(base, themeId, '/docs/notes')
    return { s, themeId, repoId, folderId: s.themes[0].items[1].id }
  }

  it('puts a removed repo back as it was, at its old position', () => {
    const { s, themeId, repoId } = withFolder()
    const repo = m.getItem(s, themeId, repoId)
    const removed = m.removeItem(s, themeId, repoId)
    const restored = m.restoreItem(removed, themeId, repo, 0)
    expect(restored.themes[0].items).toEqual(s.themes[0].items)
    expect(removed.themes[0].items).toHaveLength(1) // input untouched
  })

  it('puts a removed folder back at the end without an index, and clamps the index', () => {
    const { s, themeId, folderId } = withFolder()
    const folder = m.getItem(s, themeId, folderId)
    const removed = m.removeItem(s, themeId, folderId)
    expect(
      m
        .restoreItem(removed, themeId, folder)
        .themes[0].items.map((i) => i.id)
        .at(-1),
    ).toBe(folderId)
    expect(m.restoreItem(removed, themeId, folder, 99).themes[0].items).toEqual(s.themes[0].items)
    expect(m.restoreItem(removed, themeId, folder, -3).themes[0].items[0]).toEqual(folder)
  })

  it('rejects an item whose id, path or slug is taken meanwhile', () => {
    const { s, themeId, repoId } = withFolder()
    const repo = m.getItem(s, themeId, repoId)
    expect(() => m.restoreItem(s, themeId, repo)).toThrow('"my-api" is already in me-manager')
    const removed = m.removeItem(s, themeId, repoId)
    const readded = m.addRepo(removed, themeId, '/code/my-api')
    expect(() => m.restoreItem(readded, themeId, repo)).toThrow('/code/my-api is already in this theme')
    const sameSlug = m.addFolder(removed, themeId, '/elsewhere/my-api')
    expect(() => m.restoreItem(sameSlug, themeId, repo)).toThrow('An item named "my-api" already exists')
    expect(() => m.restoreItem(removed, 'nope', repo)).toThrow(/Theme not found/)
  })

  it('rejects malformed items, unsafe slugs, relative paths and repos with tasks', () => {
    const { s, themeId, repoId } = withFolder()
    const repo = m.getItem(s, themeId, repoId)
    const removed = m.removeItem(s, themeId, repoId)
    for (const bad of [
      null,
      'x',
      { ...repo, kind: 'task' },
      { ...repo, id: '' },
      { ...repo, name: 3 },
      { ...repo, slug: '../etc' },
      { ...repo, slug: 'a_b' },
      { ...repo, path: 'code/my-api' },
    ]) {
      expect(() => m.restoreItem(removed, themeId, bad)).toThrow(/Invalid item to restore/)
    }
    expect(() => m.restoreItem(removed, themeId, { ...repo, tasks: [task('fix')] })).toThrow(/with tasks/)
  })

  it('keeps only the known fields of a restored item', () => {
    const { s, themeId, folderId } = withFolder()
    const folder = m.getItem(s, themeId, folderId)
    const removed = m.removeItem(s, themeId, folderId)
    const restored = m.restoreItem(removed, themeId, { ...folder, extra: 'x', tasks: [] })
    expect(m.getItem(restored, themeId, folderId)).toEqual(folder)
  })

  it('puts a removed theme back with its items, at its old position', () => {
    let { s } = withFolder()
    s = m.addTheme(s, 'Personal')
    const theme = s.themes[0]
    const removed = m.removeTheme(s, theme.id)
    const restored = m.restoreTheme(removed, theme, 0)
    expect(restored).toEqual(s)
    expect(m.restoreTheme(removed, theme).themes.map((t) => t.name)).toEqual(['Personal', 'Client X'])
  })

  it('rejects a theme whose id, slug or name is taken meanwhile, or whose items clash', () => {
    const { s } = withFolder()
    const theme = s.themes[0]
    expect(() => m.restoreTheme(s, theme)).toThrow('"Client X" is already in me-manager')
    const removed = m.removeTheme(s, theme.id)
    expect(() => m.restoreTheme(m.addTheme(removed, 'client-x'), theme)).toThrow(/already exists/)
    const other = m.addTheme(removed, 'Other')
    const renamed = m.renameTheme(other, other.themes[0].id, 'CLIENT X') // slug "other", name taken
    expect(() => m.restoreTheme(renamed, theme)).toThrow('A theme named "Client X" already exists')
    const twice = { ...theme, items: [theme.items[0], { ...theme.items[0], id: 'other-id' }] }
    expect(() => m.restoreTheme(removed, twice)).toThrow(/lists an item twice/)
    const sharedId = { ...theme, items: [theme.items[0], { ...theme.items[1], id: theme.items[0].id }] }
    expect(() => m.restoreTheme(removed, sharedId)).toThrow(/already in me-manager/)
    expect(() => m.restoreTheme(removed, { ...theme, slug: 'Client X' })).toThrow(/Invalid theme/)
    expect(() => m.restoreTheme(removed, { ...theme, items: 'x' })).toThrow(/Invalid theme/)
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
  it('archives a task, keeping its branch, base and notes, and restores it', () => {
    const { s, themeId, repoId } = setup()
    const added = m.setTaskNotes(m.addTask(s, themeId, repoId, task('fix')), themeId, repoId, 'task-fix', 'wip')
    const archived = m.archiveTask(added, themeId, repoId, 'task-fix', '2026-02-01T10:00:00.000Z')
    expect(m.getTask(archived, themeId, repoId, 'task-fix')).toEqual({
      ...task('fix'),
      notes: 'wip',
      archivedAt: '2026-02-01T10:00:00.000Z',
    })
    expect(m.getTask(added, themeId, repoId, 'task-fix').archivedAt).toBeUndefined() // the input is untouched
    const restored = m.unarchiveTask(archived, themeId, repoId, 'task-fix')
    expect(m.getTask(restored, themeId, repoId, 'task-fix')).toEqual({ ...task('fix'), notes: 'wip' })
  })
  it('refuses to archive an archived task or restore an active one', () => {
    const { s, themeId, repoId } = setup()
    const added = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.unarchiveTask(added, themeId, repoId, 'task-fix')).toThrow('"fix" is not archived')
    const archived = m.archiveTask(added, themeId, repoId, 'task-fix', '2026-02-01T10:00:00.000Z')
    expect(() => m.archiveTask(archived, themeId, repoId, 'task-fix', 'x')).toThrow('"fix" is already archived')
  })
  it('keeps an archived task’s name and slug taken, saying it is archived', () => {
    const { s, themeId, repoId } = setup()
    const archived = m.archiveTask(m.addTask(s, themeId, repoId, task('fix')), themeId, repoId, 'task-fix', 'x')
    expect(() => m.addTask(archived, themeId, repoId, { ...task('fix'), id: 'other' })).toThrow(
      'A task named "fix" already exists in my-api (archived)',
    )
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

describe('task notes', () => {
  function withTask(): { s: AppState; themeId: string; repoId: string } {
    const { s, themeId, repoId } = setup()
    return { s: m.addTask(s, themeId, repoId, task('fix')), themeId, repoId }
  }
  const notesOf = (s: AppState, themeId: string, repoId: string): string | undefined =>
    m.getTask(s, themeId, repoId, 'task-fix').notes

  it('sets notes, trimmed, without touching the input state', () => {
    const { s, themeId, repoId } = withTask()
    const next = m.setTaskNotes(s, themeId, repoId, 'task-fix', '  Waiting on the API team.\nThen ship.  ')
    expect(notesOf(next, themeId, repoId)).toBe('Waiting on the API team.\nThen ship.')
    expect(notesOf(s, themeId, repoId)).toBeUndefined()
  })

  it('removes the field for an empty or blank string', () => {
    const { s, themeId, repoId } = withTask()
    const withNotes = m.setTaskNotes(s, themeId, repoId, 'task-fix', 'x')
    for (const empty of ['', '  \n ']) {
      const cleared = m.getTask(
        m.setTaskNotes(withNotes, themeId, repoId, 'task-fix', empty),
        themeId,
        repoId,
        'task-fix',
      )
      expect('notes' in cleared).toBe(false)
    }
  })

  it('allows 2,000 characters and rejects more', () => {
    const { s, themeId, repoId } = withTask()
    expect(notesOf(m.setTaskNotes(s, themeId, repoId, 'task-fix', 'a'.repeat(2000)), themeId, repoId)).toHaveLength(
      2000,
    )
    expect(() => m.setTaskNotes(s, themeId, repoId, 'task-fix', 'a'.repeat(2001))).toThrow(
      'Notes are limited to 2000 characters (got 2001)',
    )
  })

  it('rejects non-text notes and unknown tasks', () => {
    const { s, themeId, repoId } = withTask()
    expect(() => m.setTaskNotes(s, themeId, repoId, 'task-fix', 42 as unknown as string)).toThrow('Notes must be text')
    expect(() => m.setTaskNotes(s, themeId, repoId, 'nope', 'x')).toThrow(/Task not found/)
  })
})

describe('run commands', () => {
  function withFolder(): { s: AppState; themeId: string; repoId: string; folderId: string } {
    const { s: base, themeId, repoId } = setup()
    const s = m.addFolder(base, themeId, '/docs/site')
    return { s, themeId, repoId, folderId: s.themes[0].items[1].id }
  }

  it("sets a repo's or folder's run command, trimmed, without touching the input state", () => {
    const { s, themeId, repoId, folderId } = withFolder()
    const next = m.setRunCommand(s, themeId, repoId, '  npm run dev ')
    expect(m.getItem(next, themeId, repoId)).toMatchObject({ kind: 'repo', runCommand: 'npm run dev' })
    expect(m.getItem(s, themeId, repoId)).not.toHaveProperty('runCommand')
    const folder = m.setRunCommand(next, themeId, folderId, 'hugo server')
    expect(m.getItem(folder, themeId, folderId)).toMatchObject({ kind: 'folder', runCommand: 'hugo server' })
  })

  it('removes the field for an empty or blank command', () => {
    const { s, themeId, repoId } = withFolder()
    const set = m.setRunCommand(s, themeId, repoId, 'npm start')
    for (const empty of ['', '   '])
      expect(m.getItem(m.setRunCommand(set, themeId, repoId, empty), themeId, repoId)).not.toHaveProperty('runCommand')
  })

  it('rejects a multi-line, over-long or non-text command, and unknown items', () => {
    const { s, themeId, repoId } = withFolder()
    expect(() => m.setRunCommand(s, themeId, repoId, 'a\nb')).toThrow('The run command must be one line of text')
    expect(() => m.setRunCommand(s, themeId, repoId, 'x'.repeat(1001))).toThrow(/limited to 1,000 characters/)
    expect(() => m.setRunCommand(s, themeId, repoId, 3 as unknown as string)).toThrow('The run command must be text')
    expect(() => m.setRunCommand(s, themeId, 'nope', 'npm start')).toThrow(/Item not found/)
  })

  it('keeps the run command when a removed item or theme is restored, dropping one that does not check out', () => {
    const { s: base, themeId, repoId, folderId } = withFolder()
    const s = m.setRunCommand(m.setRunCommand(base, themeId, repoId, 'npm run dev'), themeId, folderId, 'make serve')
    const repo = m.getItem(s, themeId, repoId)
    const removed = m.removeItem(s, themeId, repoId)
    expect(m.getItem(m.restoreItem(removed, themeId, repo, 0), themeId, repoId)).toEqual(repo)
    const bad = m.restoreItem(removed, themeId, { ...repo, runCommand: 'a\nb' })
    expect(m.getItem(bad, themeId, repoId)).not.toHaveProperty('runCommand')
    const theme = s.themes[0]
    expect(m.restoreTheme(m.removeTheme(s, themeId), theme).themes[0]).toEqual(theme)
  })
})
