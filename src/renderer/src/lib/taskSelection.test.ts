import { describe, expect, it } from 'vitest'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { filterSidebar } from './sidebarFilter'
import { neighbourTask, pruneSelection, rangeOf, selectedTasks, taskRows, toggleTask } from './taskSelection'

const old = { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z' }
const state = appState(
  theme('A', [repo('api', [task('one'), old, task('two'), task('three')]), folder('notes'), repo('web', [task('ui')])]),
  theme('B', [repo('cli', [task('x'), task('y')])]),
)
const rows = taskRows(state, new Set())
const ids = (set: ReadonlySet<string>): string[] => [...set].sort()

describe('taskRows', () => {
  it('lists the active tasks the sidebar shows, in order, with their repo', () => {
    expect(rows).toEqual([
      { taskId: 'one', repoId: 'api' },
      { taskId: 'two', repoId: 'api' },
      { taskId: 'three', repoId: 'api' },
      { taskId: 'ui', repoId: 'web' },
      { taskId: 'x', repoId: 'cli' },
      { taskId: 'y', repoId: 'cli' },
    ])
  })

  it('leaves out collapsed groups, and what the filter hides', () => {
    expect(taskRows(state, new Set(['api', 'B'])).map((r) => r.taskId)).toEqual(['ui'])
    expect(taskRows(state, new Set(['api']), filterSidebar(state, 't')).map((r) => r.taskId)).toEqual(['two', 'three'])
  })
})

describe('toggleTask', () => {
  it('adds a task, or takes it out', () => {
    expect(ids(toggleTask(new Set(['one']), 'two'))).toEqual(['one', 'two'])
    expect(ids(toggleTask(new Set(['one', 'two']), 'two'))).toEqual(['one'])
  })

  it('takes in the current task with the first one, so a click then a Mod+click selects both', () => {
    expect(ids(toggleTask(new Set(), 'two', 'one'))).toEqual(['one', 'two'])
    expect(ids(toggleTask(new Set(), 'one', 'one'))).toEqual(['one'])
    expect(ids(toggleTask(new Set(['x']), 'two', 'one'))).toEqual(['two', 'x'])
  })
})

describe('rangeOf', () => {
  it('runs from the anchor to the task, either way, within its repo', () => {
    expect(rangeOf(rows, 'one', 'three')).toEqual(['one', 'two', 'three'])
    expect(rangeOf(rows, 'three', 'two')).toEqual(['two', 'three'])
    expect(rangeOf(rows, 'two', 'two')).toEqual(['two'])
  })

  it("stops at the task's repo: an anchor in another repo counts as the end of it nearest the anchor", () => {
    expect(rangeOf(rows, 'one', 'y')).toEqual(['x', 'y'])
    expect(rangeOf(rows, 'y', 'two')).toEqual(['two', 'three'])
  })

  it('is the task alone without an anchor, or one the sidebar does not show', () => {
    expect(rangeOf(rows, undefined, 'two')).toEqual(['two'])
    expect(rangeOf(rows, 'old', 'two')).toEqual(['two'])
    expect(rangeOf(rows, 'one', 'old')).toEqual([])
  })
})

describe('neighbourTask', () => {
  it('is the task row above or below in the same repo, none past either end', () => {
    expect(neighbourTask(rows, 'one', 1)).toBe('two')
    expect(neighbourTask(rows, 'three', -1)).toBe('two')
    expect(neighbourTask(rows, 'three', 1)).toBeUndefined()
    expect(neighbourTask(rows, 'one', -1)).toBeUndefined()
    expect(neighbourTask(rows, 'old', 1)).toBeUndefined()
  })
})

describe('pruneSelection', () => {
  it('keeps the active tasks that are still there', () => {
    expect(ids(pruneSelection(state, new Set(['one', 'old', 'gone', 'y'])))).toEqual(['one', 'y'])
  })

  it('hands back the same set when nothing goes', () => {
    const selection = new Set(['one', 'y'])
    expect(pruneSelection(state, selection)).toBe(selection)
  })
})

describe('selectedTasks', () => {
  it('resolves the selection in sidebar order, with each task, its target and its repo', () => {
    const found = selectedTasks(state, new Set(['y', 'two', 'old']))
    expect(found.map((f) => [f.task.name, f.repoName, f.target])).toEqual([
      ['two', 'api', { themeId: 'A', itemId: 'api', taskId: 'two' }],
      ['y', 'cli', { themeId: 'B', itemId: 'cli', taskId: 'y' }],
    ])
  })
})
