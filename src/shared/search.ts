import type { SearchMatch, SearchOptions } from './types'

/** The longest search query accepted, in characters. */
export const MAX_SEARCH_QUERY = 500
/** Matches returned at most; the result is then marked `truncated`. */
export const MAX_SEARCH_MATCHES = 500
/** The longest preview of a matching line, in characters (an ellipsis included). */
export const MAX_SEARCH_PREVIEW = 200
/** How many characters before the match a long line's preview keeps. */
const PREVIEW_CONTEXT = 40

/** `options` as sent over IPC: anything but `true` is off. */
export function normalizeSearchOptions(raw: unknown): Required<SearchOptions> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { caseSensitive: o.caseSensitive === true, regex: o.regex === true }
}

/**
 * Throws a user-facing error for a query that can't be searched: not a string, empty or only whitespace, over
 * MAX_SEARCH_QUERY characters, or spanning lines (a search matches within one line).
 */
export function checkSearchQuery(query: unknown): string {
  if (typeof query !== 'string' || query.trim() === '') throw new Error('Type something to search for')
  if (query.length > MAX_SEARCH_QUERY)
    throw new Error(`The search is limited to ${MAX_SEARCH_QUERY.toLocaleString('en-US')} characters`)
  if (/[\0\r\n]/.test(query)) throw new Error('Search for text within one line')
  return query
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The JavaScript pattern for a search: the query itself in regex mode, or escaped to match literally. Throws
 * "Invalid regular expression: …" when it doesn't compile.
 */
export function searchPattern(query: string, options: SearchOptions): RegExp {
  const flags = options.caseSensitive ? '' : 'i'
  try {
    return new RegExp(options.regex ? query : escapeRegExp(query), flags)
  } catch (err) {
    // V8 says "Invalid regular expression: /(/: Unterminated group": keep the reason only.
    const reason = String((err as Error).message ?? err).replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '')
    throw new Error(`Invalid regular expression: ${reason}`, { cause: err })
  }
}

/**
 * A match on line `line` (1-based) whose text is `lineText`, found at character `start` with `length` characters.
 * The preview drops the indentation and, for a long line, keeps a window around the match, marked with ellipses.
 */
export function makeMatch(path: string, line: number, lineText: string, start: number, length: number): SearchMatch {
  let text = lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText
  let s = Math.max(0, Math.min(start, text.length))
  const column = s + 1
  const indent = text.length - text.trimStart().length
  if (indent > 0 && indent <= s) {
    text = text.slice(indent)
    s -= indent
  }
  let len = Math.max(0, Math.min(length, text.length - s))
  if (text.length <= MAX_SEARCH_PREVIEW) return { path, line, column, preview: text, matchStart: s, matchLength: len }
  const begin = Math.max(0, s - PREVIEW_CONTEXT)
  const prefix = begin > 0 ? '…' : ''
  let room = MAX_SEARCH_PREVIEW - prefix.length
  const more = begin + room < text.length
  if (more) room -= 1
  const body = text.slice(begin, begin + room)
  len = Math.max(0, Math.min(len, body.length - (s - begin)))
  return {
    path,
    line,
    column,
    preview: `${prefix}${body}${more ? '…' : ''}`,
    matchStart: prefix.length + (s - begin),
    matchLength: len,
  }
}
