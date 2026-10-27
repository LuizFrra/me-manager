import { describe, expect, it } from 'vitest'
import {
  graphemeCount,
  isThemeColor,
  MAX_THEME_ICON,
  normalizeThemeStyle,
  THEME_COLORS,
  THEME_EMOJI,
  themeColorCss,
  themeIconError,
} from './themeStyle'

describe('theme colours', () => {
  it('has a fixed palette of 8 named colours, looked up by name only', () => {
    expect(THEME_COLORS).toHaveLength(8)
    expect(new Set(THEME_COLORS.map((c) => c.name)).size).toBe(8)
    expect(isThemeColor('blue')).toBe(true)
    expect(isThemeColor('#ff0000')).toBe(false)
    expect(themeColorCss('green')).toMatch(/^#[0-9a-f]{6}$/)
    expect(themeColorCss('red; background: url(x)')).toBeUndefined()
    expect(themeColorCss(undefined)).toBeUndefined()
  })
})

describe('theme icons', () => {
  it('accepts one emoji, including ZWJ sequences, flags, keycaps and skin tones', () => {
    for (const icon of ['🚀', '⭐', '🛠️', '👩‍💻', '🇧🇷', '1️⃣', '👍🏽', ' 🔥 ', ...THEME_EMOJI])
      expect(themeIconError(icon), icon).toBeNull()
  })

  it('accepts a single emoji however many code units it takes', () => {
    // A family (11 units), a subdivision flag (14) and a couple with skin tones (15).
    for (const icon of ['👨‍👩‍👧‍👦', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🧑🏻‍❤️‍💋‍🧑🏼']) {
      expect(icon.length).toBeGreaterThan(8)
      expect(themeIconError(icon), icon).toBeNull()
      expect(graphemeCount(icon, false), icon).toBe(1)
    }
  })

  it("treats '' and whitespace as no icon", () => {
    expect(themeIconError('')).toBeNull()
    expect(themeIconError('   ')).toBeNull()
  })

  it('refuses text, several emoji, long sequences, control characters and non-strings', () => {
    expect(themeIconError('a')).toBe('Use an emoji, not a letter or symbol')
    expect(themeIconError('#')).toBe('Use an emoji, not a letter or symbol')
    expect(themeIconError('🚀🔥')).toBe('Use a single emoji')
    expect(themeIconError('ab')).toBe('Use a single emoji')
    const chain = `🚀${'\u200d🚀'.repeat(20)}` // one grapheme, but no emoji is that long
    expect(chain.length).toBeGreaterThan(MAX_THEME_ICON)
    expect(themeIconError(chain)).toBe('Use a single emoji')
    expect(themeIconError('🚀\n')).toBeNull() // trimmed
    expect(themeIconError('\u0007🚀')).toBe('The icon must be an emoji')
    expect(themeIconError(42)).toBe('The icon must be an emoji')
  })

  it('counts graphemes the same way without Intl.Segmenter', () => {
    for (const [text, n] of [
      ['🚀', 1],
      ['👩‍💻', 1],
      ['🇧🇷', 1],
      ['🇧🇷🇵🇹', 2],
      ['1️⃣', 1],
      ['👍🏽', 1],
      ['🛠️', 1],
      ['ab', 2],
      ['🚀🔥', 2],
    ] as const) {
      expect(graphemeCount(text), text).toBe(n)
      expect(graphemeCount(text, false), `${text} (fallback)`).toBe(n)
    }
  })
})

describe('normalizeThemeStyle', () => {
  it('keeps a known colour and a trimmed emoji, and drops empty fields', () => {
    expect(normalizeThemeStyle({ color: 'teal', icon: ' 🚀 ' })).toEqual({ color: 'teal', icon: '🚀' })
    expect(normalizeThemeStyle({ color: '', icon: '' })).toEqual({})
    expect(normalizeThemeStyle({ color: null, icon: null })).toEqual({})
    expect(normalizeThemeStyle(undefined)).toEqual({})
    expect(normalizeThemeStyle({ color: 'blue', extra: 'x' })).toEqual({ color: 'blue' })
  })

  it('throws on an unknown colour, a bad icon or a non-object', () => {
    expect(() => normalizeThemeStyle({ color: '#123456' })).toThrow('Unknown theme colour: #123456')
    expect(() => normalizeThemeStyle({ icon: 'hello' })).toThrow('Use a single emoji')
    expect(() => normalizeThemeStyle({ icon: 7 })).toThrow('The icon must be an emoji')
    expect(() => normalizeThemeStyle('blue')).toThrow('Invalid theme style')
    expect(() => normalizeThemeStyle([])).toThrow('Invalid theme style')
  })
})
