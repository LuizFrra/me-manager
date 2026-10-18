import { describe, expect, it } from 'vitest'
import type { TaskGitStatus } from '../../../shared/types'
import { baseSummary, gitBadges } from './gitStatus'

const status = (patch: Partial<TaskGitStatus> = {}): TaskGitStatus => ({
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  branch: 'claude/x/fix',
  ...patch,
})

describe('gitBadges', () => {
  it('shows nothing for a clean task level with its base', () => {
    expect(gitBadges(status(), 'origin/main')).toEqual([])
  })
  it('shows ahead, behind and uncommitted counts with tooltips', () => {
    expect(gitBadges(status({ ahead: 3, behind: 1, uncommitted: 2 }), 'origin/main')).toEqual([
      { kind: 'ahead', text: '↑3', title: '3 commits ahead of origin/main' },
      { kind: 'behind', text: '↓1', title: '1 commit behind origin/main' },
      { kind: 'dirty', text: '●2', title: '2 uncommitted files' },
    ])
  })
  it('uses the singular for one', () => {
    expect(gitBadges(status({ ahead: 1, uncommitted: 1 }), 'main').map((b) => b.title)).toEqual([
      '1 commit ahead of main',
      '1 uncommitted file',
    ])
  })
})

describe('baseSummary', () => {
  it('describes the task against its base', () => {
    expect(baseSummary(status(), 'origin/main')).toBe('Up to date with origin/main')
    expect(baseSummary(status({ ahead: 2 }), 'origin/main')).toBe('2 commits ahead of origin/main')
    expect(baseSummary(status({ behind: 1 }), 'origin/main')).toBe('1 commit behind origin/main')
    expect(baseSummary(status({ ahead: 2, behind: 1 }), 'origin/main')).toBe('2 ahead, 1 behind origin/main')
    expect(baseSummary(status({ baseMissing: true }), 'origin/gone')).toBe('Base origin/gone not found')
  })
})
