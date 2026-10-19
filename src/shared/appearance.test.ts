import { describe, expect, it } from 'vitest'
import { APPEARANCE_BACKGROUND, resolveAppearance } from './appearance'

describe('resolveAppearance', () => {
  it('keeps dark and light, and resolves system from the OS preference', () => {
    expect(resolveAppearance('dark', false)).toBe('dark')
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
  })

  it('has a page background for each resolved appearance', () => {
    expect(APPEARANCE_BACKGROUND).toEqual({ dark: '#1e1e1e', light: '#ffffff' })
  })
})
