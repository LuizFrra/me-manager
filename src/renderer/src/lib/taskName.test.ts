import { describe, expect, it } from 'vitest'
import { newTaskNameError } from './taskName'

const tasks = [
  { name: 'fix login bug', slug: 'fix-login-bug' },
  { name: 'Old idea', slug: 'old-idea', archived: true },
  // Renamed: the slug (so the branch) is still the original one.
  { name: 'Docs', slug: 'write-docs' },
]

describe('newTaskNameError', () => {
  it('accepts a free name, and says nothing while the field is empty', () => {
    expect(newTaskNameError('add search', tasks)).toBeNull()
    expect(newTaskNameError('', tasks)).toBeNull()
    expect(newTaskNameError('   ', tasks)).toBeNull()
  })

  it('needs letters or numbers, which the branch and folder are named after', () => {
    expect(newTaskNameError('!!!', tasks)).toMatch(/letters or numbers/)
    expect(newTaskNameError('日本語', tasks)).toMatch(/letters or numbers/)
  })

  it("refuses another task's name, ignoring case and surrounding spaces, archived ones included", () => {
    expect(newTaskNameError('  FIX login bug ', tasks)).toBe('A task named “fix login bug” already exists.')
    expect(newTaskNameError('old idea', tasks)).toBe('A task named “Old idea” already exists (archived).')
  })

  it("refuses a name that would use another task's branch, by the task's real slug", () => {
    expect(newTaskNameError('Fix-Login-Bug!', tasks)).toBe(
      'The task “fix login bug” already uses the branch this name gives (…/fix-login-bug).',
    )
    expect(newTaskNameError('write docs', tasks)).toMatch(/“Docs” already uses the branch/)
    expect(newTaskNameError('docs', tasks)).toBe('A task named “Docs” already exists.')
  })
})
