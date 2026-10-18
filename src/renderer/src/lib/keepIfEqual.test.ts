import { describe, expect, it } from 'vitest'
import { keepIfEqual } from './keepIfEqual'

describe('keepIfEqual', () => {
  it('keeps the previous value when the next one has the same JSON', () => {
    const prev = { running: ['a'], missing: [] }
    expect(keepIfEqual({ running: ['a'], missing: [] })(prev)).toBe(prev)
  })

  it('returns the next value when it differs', () => {
    const prev = [{ index: 0, name: 'claude', active: true }]
    const next = [{ index: 0, name: 'claude', active: false }]
    expect(keepIfEqual(next)(prev)).toBe(next)
  })
})
