import { describe, expect, it } from 'vitest'
import type { Task } from './types'
import { clampIndex, moveActiveTask, moveEntry } from './reorder'

const task = (id: string, archived = false): Task => ({
  id,
  name: id,
  slug: id,
  branch: `b/${id}`,
  worktreePath: `/wt/${id}`,
  baseRef: 'origin/main',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...(archived ? { archivedAt: '2026-02-01T00:00:00.000Z' } : {}),
})
const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id)

describe('clampIndex', () => {
  it('keeps an index inside the list', () => {
    expect(clampIndex(-3, 4)).toBe(0)
    expect(clampIndex(2, 4)).toBe(2)
    expect(clampIndex(9, 4)).toBe(3)
    expect(clampIndex(5, 0)).toBe(0)
  })
})

describe('moveEntry', () => {
  it('moves an entry to its new index, without touching the input', () => {
    const list = ['a', 'b', 'c', 'd']
    expect(moveEntry(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveEntry(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveEntry(list, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })

  it('clamps the index, and hands back the same list when nothing moves', () => {
    const list = ['a', 'b', 'c']
    expect(moveEntry(list, 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveEntry(list, 2, -5)).toEqual(['c', 'a', 'b'])
    expect(moveEntry(list, 1, 1)).toBe(list)
    expect(moveEntry(list, 0, -1)).toBe(list)
    expect(moveEntry(list, 2, 3)).toBe(list)
    expect(moveEntry(list, 7, 0)).toBe(list) // no such entry
  })
})

describe('moveActiveTask', () => {
  it('counts positions among the active tasks only; archived ones keep their slots', () => {
    const tasks = [task('a'), task('old', true), task('b'), task('c'), task('older', true)]
    expect(ids(moveActiveTask(tasks, 'c', 0))).toEqual(['c', 'old', 'a', 'b', 'older'])
    expect(ids(moveActiveTask(tasks, 'a', 1))).toEqual(['b', 'old', 'a', 'c', 'older'])
    expect(ids(moveActiveTask(tasks, 'a', 99))).toEqual(['b', 'old', 'c', 'a', 'older'])
  })

  it('hands back the same list when nothing moves, or the task is not an active one', () => {
    const tasks = [task('a'), task('old', true), task('b')]
    expect(moveActiveTask(tasks, 'b', 1)).toBe(tasks)
    expect(moveActiveTask(tasks, 'b', 7)).toBe(tasks)
    expect(moveActiveTask(tasks, 'old', 0)).toBe(tasks)
    expect(moveActiveTask(tasks, 'nope', 0)).toBe(tasks)
  })
})
