import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../shared/types'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { applyMove, dropIndex, moveAnnouncement, sendMove, stepMove, type MoveEntry } from './reorder'

const old = { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z' }
const state = appState(
  theme('A', [repo('api', [task('one'), old, task('two'), task('three')]), folder('notes')]),
  theme('B', [repo('web', [task('ui')])]),
  theme('C', []),
)
const apiTasks: MoveEntry = { kind: 'task', themeId: 'A', repoId: 'api', taskId: 'two' }
const names = (s: AppState): string[] => s.themes.map((t) => t.name)
const taskNames = (s: AppState): string[] => {
  const r = s.themes[0].items.find((i) => i.id === 'api')
  return r?.kind === 'repo' ? r.tasks.map((t) => t.name) : []
}

describe('applyMove', () => {
  it('moves a theme, an item or an active task like main, without touching the input', () => {
    expect(names(applyMove(state, { kind: 'theme', themeId: 'A', toIndex: 2 }))).toEqual(['B', 'C', 'A'])
    const items = applyMove(state, { kind: 'item', themeId: 'A', itemId: 'notes', toIndex: 0 }).themes[0].items
    expect(items.map((i) => i.name)).toEqual(['notes', 'api'])
    expect(taskNames(applyMove(state, { ...apiTasks, toIndex: 0 }))).toEqual(['two', 'old', 'one', 'three'])
    expect(names(state)).toEqual(['A', 'B', 'C'])
    expect(taskNames(state)).toEqual(['one', 'old', 'two', 'three'])
  })

  it('hands back the same state when nothing moves, or the entry is gone', () => {
    expect(applyMove(state, { kind: 'theme', themeId: 'A', toIndex: -1 })).toBe(state)
    expect(applyMove(state, { ...apiTasks, toIndex: 1 })).toBe(state)
    expect(applyMove(state, { kind: 'theme', themeId: 'gone', toIndex: 0 })).toBe(state)
    expect(applyMove(state, { kind: 'item', themeId: 'B', itemId: 'notes', toIndex: 0 })).toBe(state)
    expect(applyMove(state, { kind: 'task', themeId: 'A', repoId: 'api', taskId: 'old', toIndex: 0 })).toBe(state)
  })
})

describe('stepMove', () => {
  it('is one step up or down among the siblings, null at either end', () => {
    expect(stepMove(state, apiTasks, -1)).toEqual({ ...apiTasks, toIndex: 0 })
    expect(stepMove(state, apiTasks, 1)).toEqual({ ...apiTasks, toIndex: 2 })
    expect(stepMove(state, { kind: 'theme', themeId: 'A' }, -1)).toBeNull()
    expect(stepMove(state, { kind: 'theme', themeId: 'C' }, 1)).toBeNull()
    expect(stepMove(state, { kind: 'item', themeId: 'A', itemId: 'notes' }, -1)).toMatchObject({ toIndex: 0 })
    expect(stepMove(state, { kind: 'task', themeId: 'B', repoId: 'web', taskId: 'ui' }, 1)).toBeNull()
  })
})

describe('dropIndex', () => {
  const ids = ['a', 'b', 'c', 'd']
  it('is where the dragged entry ends up when dropped before or after a row', () => {
    expect(dropIndex(ids, 'a', 'c', 'before')).toBe(1)
    expect(dropIndex(ids, 'a', 'c', 'after')).toBe(2)
    expect(dropIndex(ids, 'a', 'd', 'after')).toBe(3)
    expect(dropIndex(ids, 'd', 'a', 'before')).toBe(0)
    expect(dropIndex(ids, 'd', 'b', 'after')).toBe(2)
  })
  it('is null when it would stay where it is, or a row is unknown', () => {
    expect(dropIndex(ids, 'b', 'b', 'before')).toBeNull()
    expect(dropIndex(ids, 'b', 'a', 'after')).toBeNull()
    expect(dropIndex(ids, 'b', 'c', 'before')).toBeNull()
    expect(dropIndex(ids, 'x', 'c', 'before')).toBeNull()
    expect(dropIndex(ids, 'a', 'x', 'before')).toBeNull()
  })
})

describe('moveAnnouncement', () => {
  it('names the entry and its position among its siblings, archived tasks not counted', () => {
    const moved = applyMove(state, { ...apiTasks, toIndex: 0 })
    expect(moveAnnouncement(moved, apiTasks)).toBe('Moved two to position 1 of 3')
    expect(moveAnnouncement(state, { kind: 'theme', themeId: 'C' })).toBe('Moved C to position 3 of 3')
    expect(moveAnnouncement(state, { kind: 'item', themeId: 'A', itemId: 'notes' })).toBe(
      'Moved notes to position 2 of 2',
    )
    expect(moveAnnouncement(state, { kind: 'theme', themeId: 'gone' })).toBeNull()
  })
})

describe('sendMove', () => {
  it('calls the API method of the entry kind', async () => {
    const api = { moveTheme: vi.fn(), moveItem: vi.fn(), moveTask: vi.fn() }
    await sendMove(api, { kind: 'theme', themeId: 'A', toIndex: 1 })
    await sendMove(api, { kind: 'item', themeId: 'A', itemId: 'notes', toIndex: 0 })
    await sendMove(api, { ...apiTasks, toIndex: 2 })
    expect(api.moveTheme).toHaveBeenCalledWith('A', 1)
    expect(api.moveItem).toHaveBeenCalledWith('A', 'notes', 0)
    expect(api.moveTask).toHaveBeenCalledWith('A', 'api', 'two', 2)
  })
})
