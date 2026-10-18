import { describe, expect, it } from 'vitest'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { allTargets } from './targets'

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
