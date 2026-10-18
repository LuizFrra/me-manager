import { describe, expect, it } from 'vitest'
import { sessionState } from './sessionState'

describe('sessionState', () => {
  const status = { running: ['a', 'b', 'c'], missing: ['m', 'c'], activity: { a: 'busy' as const, c: 'idle' as const } }
  it('prefers missing, then no session, then the activity, then plain running', () => {
    expect(sessionState(status, 'c')).toBe('missing')
    expect(sessionState(status, 'x')).toBe('none')
    expect(sessionState(status, 'a')).toBe('busy')
    expect(sessionState(status, 'b')).toBe('running')
  })
})
