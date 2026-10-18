import { describe, expect, it } from 'vitest'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { allTargets, visibleTargets } from './targets'

describe('allTargets', () => {
  it('lists tasks and folders in sidebar order with breadcrumb labels', () => {
    const state = appState(
      theme('Client X', [repo('api', [task('fix login'), task('add tests')]), folder('notes')]),
      theme('Personal', [repo('empty', []), folder('blog')]),
    )
    expect(allTargets(state)).toEqual([
      {
        target: { themeId: 'Client X', itemId: 'api', taskId: 'fix login' },
        kind: 'task',
        label: 'Client X › api › fix login',
      },
      {
        target: { themeId: 'Client X', itemId: 'api', taskId: 'add tests' },
        kind: 'task',
        label: 'Client X › api › add tests',
      },
      { target: { themeId: 'Client X', itemId: 'notes' }, kind: 'folder', label: 'Client X › notes' },
      { target: { themeId: 'Personal', itemId: 'blog' }, kind: 'folder', label: 'Personal › blog' },
    ])
  })

  it('is empty without themes', () => {
    expect(allTargets(appState())).toEqual([])
  })
})

describe('visibleTargets', () => {
  const state = appState(
    theme('A', [repo('api', [task('t1'), task('t2')]), folder('notes')]),
    theme('B', [folder('blog'), repo('web', [task('t3')])]),
  )
  const ids = (collapsed: string[]): string[] =>
    visibleTargets(state, new Set(collapsed)).map((t) => t.taskId ?? t.itemId)

  it('lists every task and folder in sidebar order when nothing is collapsed', () => {
    expect(ids([])).toEqual(['t1', 't2', 'notes', 'blog', 't3'])
  })

  it('skips the tasks of a collapsed repo and everything in a collapsed theme', () => {
    expect(ids(['api'])).toEqual(['notes', 'blog', 't3'])
    expect(ids(['A'])).toEqual(['blog', 't3'])
    expect(ids(['A', 'web'])).toEqual(['blog'])
  })
})
