import { describe, expect, it } from 'vitest'
import type { LiveStatus } from '../../../shared/types'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { finishedIds, waitingTargets, windowTitle } from './attention'

const state = appState(theme('Client', [repo('api', [task('fix'), task('docs')]), folder('notes')]))
const status = (activity: LiveStatus['activity']): LiveStatus => ({
  running: Object.keys(activity),
  missing: [],
  activity,
})

describe('waitingTargets', () => {
  it('lists the tasks and folders waiting for the user, in sidebar order', () => {
    const waiting = waitingTargets(state, status({ notes: 'waiting', docs: 'waiting', fix: 'busy' }))
    expect(waiting.map((e) => e.label)).toEqual(['Client › api › docs', 'Client › notes'])
  })
})

describe('windowTitle', () => {
  it('names the selection and counts what waits for the user', () => {
    const target = { themeId: 'Client', itemId: 'api', taskId: 'fix' }
    expect(windowTitle(state, status({}), null)).toBe('me-manager')
    expect(windowTitle(state, status({}), target)).toBe('fix — me-manager')
    expect(windowTitle(state, status({ docs: 'waiting', notes: 'waiting' }), target)).toBe('(2) fix — me-manager')
    expect(windowTitle(state, status({ docs: 'waiting' }), { themeId: 'Client', itemId: 'gone' })).toBe(
      '(1) me-manager',
    )
  })
})

describe('finishedIds', () => {
  it('lists the sessions that went from busy to idle or waiting', () => {
    expect(
      finishedIds(
        { a: 'busy', b: 'busy', c: 'busy', d: 'idle', e: 'busy' },
        { a: 'idle', b: 'waiting', c: 'busy', d: 'waiting' },
      ),
    ).toEqual(['a', 'b'])
  })
})
