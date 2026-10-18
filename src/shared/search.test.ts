import { describe, expect, it } from 'vitest'
import {
  checkSearchQuery,
  makeMatch,
  MAX_SEARCH_PREVIEW,
  MAX_SEARCH_QUERY,
  normalizeSearchOptions,
  searchPattern,
} from './search'

describe('checkSearchQuery', () => {
  it('accepts a one-line query up to the limit, unchanged', () => {
    expect(checkSearchQuery(' a b ')).toBe(' a b ')
    expect(checkSearchQuery('x'.repeat(MAX_SEARCH_QUERY))).toHaveLength(MAX_SEARCH_QUERY)
  })

  it('rejects non-strings, blank, multi-line and too long queries', () => {
    expect(() => checkSearchQuery(undefined)).toThrow('Type something to search for')
    expect(() => checkSearchQuery('  ')).toThrow('Type something to search for')
    expect(() => checkSearchQuery('a\nb')).toThrow('within one line')
    expect(() => checkSearchQuery('a\0b')).toThrow('within one line')
    expect(() => checkSearchQuery('x'.repeat(MAX_SEARCH_QUERY + 1))).toThrow('limited to 500 characters')
  })
})

describe('normalizeSearchOptions', () => {
  it('turns on only what is exactly true', () => {
    expect(normalizeSearchOptions(undefined)).toEqual({ caseSensitive: false, regex: false })
    expect(normalizeSearchOptions({ caseSensitive: 'yes', regex: true })).toEqual({ caseSensitive: false, regex: true })
  })
})

describe('searchPattern', () => {
  it('escapes a literal query and is case-insensitive unless asked', () => {
    const re = searchPattern('a.b(c)', {})
    expect(re.test('A.B(C)')).toBe(true)
    expect(re.test('axb(c)')).toBe(false)
    expect(searchPattern('A', { caseSensitive: true }).test('a')).toBe(false)
  })

  it('compiles a regex, or explains why it cannot', () => {
    expect(searchPattern('a+b', { regex: true }).test('aaab')).toBe(true)
    expect(() => searchPattern('a(', { regex: true })).toThrow('Invalid regular expression: Unterminated group')
  })
})

describe('makeMatch', () => {
  it('keeps a short line whole, minus its indentation and a trailing CR', () => {
    expect(makeMatch('a.ts', 3, '    return foo\r', 11, 3)).toEqual({
      path: 'a.ts',
      line: 3,
      column: 12,
      preview: 'return foo',
      matchStart: 7,
      matchLength: 3,
    })
  })

  it('keeps the indentation when the match is in it', () => {
    expect(makeMatch('a.ts', 1, '  x', 0, 2)).toMatchObject({ preview: '  x', matchStart: 0, matchLength: 2 })
  })

  it('cuts a long line to a window around the match, with ellipses', () => {
    const line = `${'a'.repeat(500)}MATCH${'b'.repeat(500)}`
    const m = makeMatch('a.ts', 1, line, 500, 5)
    expect(m.preview).toHaveLength(MAX_SEARCH_PREVIEW)
    expect(m.preview[0]).toBe('…')
    expect(m.preview.at(-1)).toBe('…')
    expect(m.preview.slice(m.matchStart, m.matchStart + m.matchLength)).toBe('MATCH')
    expect(m.column).toBe(501)
  })

  it('clips a match that runs past the preview', () => {
    const m = makeMatch('a.ts', 1, 'x'.repeat(1000), 10, 900)
    expect(m.preview.startsWith('…')).toBe(false)
    expect(m.matchStart + m.matchLength).toBeLessThanOrEqual(m.preview.length - 1)
  })
})
