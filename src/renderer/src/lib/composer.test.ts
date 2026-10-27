import { describe, expect, it } from 'vitest'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { defaultRepo, greeting, repoChoices, taskNameFromPrompt } from './composer'

describe('repoChoices', () => {
  it('lists every repository, theme by theme, without folders', () => {
    const state = appState(theme('Client', [repo('api', []), folder('notes'), repo('web', [])]), theme('Me', []))
    expect(repoChoices(state)).toEqual([
      { themeId: 'Client', repoId: 'api', label: 'Client › api' },
      { themeId: 'Client', repoId: 'web', label: 'Client › web' },
    ])
  })
})

describe('defaultRepo', () => {
  it('is the repository of the newest task', () => {
    const newer = { ...task('b'), createdAt: '2026-03-01T00:00:00.000Z' }
    const state = appState(theme('A', [repo('api', [task('a')]), repo('web', [newer])]))
    expect(defaultRepo(state)).toEqual({ themeId: 'A', repoId: 'web' })
  })

  it('is the first repository when there are no tasks, and none without repositories', () => {
    expect(defaultRepo(appState(theme('A', [folder('f'), repo('api', [])])))).toEqual({ themeId: 'A', repoId: 'api' })
    expect(defaultRepo(appState(theme('A', [folder('f')])))).toBeNull()
  })
})

describe('taskNameFromPrompt', () => {
  it('takes the first words of the first line, without punctuation', () => {
    expect(taskNameFromPrompt('Fix the login redirect, it loops forever.\nMore details', [])).toBe(
      'Fix the login redirect it loops',
    )
  })

  it('stays within 40 characters, at a word boundary', () => {
    const name = taskNameFromPrompt('Refactorization internationalization authentication orchestration', [])
    expect(name.length).toBeLessThanOrEqual(40)
    expect(name).toBe('Refactorization internationalization')
  })

  it('adds a number when the slug is taken', () => {
    expect(taskNameFromPrompt('Add search', ['add-search'])).toBe('Add search 2')
    expect(taskNameFromPrompt('Add search', ['add-search', 'add-search-2'])).toBe('Add search 3')
  })

  it('falls back to "task" when the prompt has no letters or digits a slug keeps', () => {
    expect(taskNameFromPrompt('¿¡ … !?', [])).toBe('task')
  })

  it('names the task with words in any script', () => {
    expect(taskNameFromPrompt('修复登录 bug', [])).toBe('修复登录 bug')
  })
})

describe('greeting', () => {
  it.each([
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [2, 'Good evening'],
  ])('at %i h is "%s"', (hour, text) => {
    expect(greeting(new Date(2026, 0, 1, hour))).toBe(text)
  })
})
