import { describe, expect, it } from 'vitest'
import { runLabel, runState } from './run'

describe('runState', () => {
  it('is none without a run tab, stopped when its command exited, running otherwise', () => {
    expect(runState([{ index: 0, name: 'claude', active: true }])).toBe('none')
    expect(runState([])).toBe('none')
    expect(
      runState([
        { index: 0, name: 'claude', active: false },
        { index: 1, name: 'run', active: true },
      ]),
    ).toBe('running')
    expect(runState([{ index: 2, name: 'run', active: false, dead: true }])).toBe('stopped')
    // Only the tab named exactly "run".
    expect(runState([{ index: 1, name: 'run 2', active: true }])).toBe('none')
  })
})

describe('runLabel', () => {
  it('shows a command whole up to 40 characters, then cut with an ellipsis', () => {
    expect(runLabel('npm run dev')).toBe('npm run dev')
    expect(runLabel('x'.repeat(40))).toBe('x'.repeat(40))
    expect(runLabel(`${'y'.repeat(45)}`)).toBe(`${'y'.repeat(39)}…`)
  })
})
