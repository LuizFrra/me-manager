import { describe, expect, it } from 'vitest'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { homeTips, recentTasks, timeAgo } from './onboarding'

const at = (name: string, createdAt: string): ReturnType<typeof task> => ({ ...task(name), createdAt })

describe('recentTasks', () => {
  it('lists the newest tasks across themes, at most 5 by default', () => {
    const state = appState(
      theme('A', [repo('api', [at('a1', '2026-01-01T00:00:00Z'), at('a2', '2026-03-01T00:00:00Z')]), folder('notes')]),
      theme('B', [
        repo('web', [
          at('b1', '2026-02-01T00:00:00Z'),
          at('b2', '2026-05-01T00:00:00Z'),
          at('b3', '2026-04-01T00:00:00Z'),
          at('b4', 'not a date'),
        ]),
      ]),
    )
    const recent = recentTasks(state)
    expect(recent.map((r) => r.task.name)).toEqual(['b2', 'b3', 'a2', 'b1', 'a1'])
    expect(recent[0]).toMatchObject({ target: { themeId: 'B', itemId: 'web', taskId: 'b2' }, repoName: 'web' })
    expect(recent[0].theme.name).toBe('B')
    expect(recentTasks(state, 2)).toHaveLength(2)
    expect(recentTasks(appState(theme('Empty', [folder('f')])))).toEqual([])
  })

  it('leaves out archived tasks', () => {
    const archived = { ...at('new', '2026-05-01T00:00:00Z'), archivedAt: '2026-06-01T00:00:00Z' }
    const state = appState(theme('A', [repo('api', [at('old', '2026-01-01T00:00:00Z'), archived])]))
    expect(recentTasks(state).map((r) => r.task.name)).toEqual(['old'])
  })
})

describe('homeTips', () => {
  it("uses the platform's modifier labels", () => {
    const linux = homeTips(false)
    expect(linux[0]).toBe('Press Ctrl+Shift+P to jump to any task, folder, file or action.')
    expect(linux.join(' ')).toContain('Ctrl+Shift+E')
    expect(linux.join(' ')).toContain('Ctrl+Shift+S')
    expect(linux.join(' ')).toContain('Alt+1…9')
    const mac = homeTips(true)
    expect(mac[0]).toBe('Press ⌘K to jump to any task, folder, file or action.')
    expect(mac.join(' ')).toContain('⌘⇧E')
    expect(mac.join(' ')).toContain('⌘1…9')
    expect(mac.join(' ')).not.toContain('Ctrl')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-10-19T12:00:00Z')
  it.each([
    ['2026-10-19T11:59:40Z', 'just now'],
    ['2026-10-19T11:55:00Z', '5 min ago'],
    ['2026-10-19T09:00:00Z', '3 h ago'],
    ['2026-10-18T10:00:00Z', 'yesterday'],
    ['2026-10-15T12:00:00Z', '4 days ago'],
    ['2026-09-01T12:00:00Z', 'Sep 1'],
    ['nonsense', ''],
  ])('%s is "%s"', (iso, text) => {
    expect(timeAgo(iso, now)).toBe(text)
  })
})
