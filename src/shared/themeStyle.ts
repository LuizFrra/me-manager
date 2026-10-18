import type { ThemeColor, ThemeStyle } from './types'

/**
 * The colours a theme can have, stored by name (never as CSS). Each is bright enough to read as a stripe or text on
 * the app's dark panels (at least 3:1 against #252526).
 */
export const THEME_COLORS: readonly { name: ThemeColor; label: string; css: string }[] = [
  { name: 'blue', label: 'Blue', css: '#4fa3ff' },
  { name: 'teal', label: 'Teal', css: '#2bc7b4' },
  { name: 'green', label: 'Green', css: '#3fb950' },
  { name: 'yellow', label: 'Yellow', css: '#e3b341' },
  { name: 'orange', label: 'Orange', css: '#f0883e' },
  { name: 'red', label: 'Red', css: '#f47067' },
  { name: 'pink', label: 'Pink', css: '#f778ba' },
  { name: 'purple', label: 'Purple', css: '#a371f7' },
]

export const isThemeColor = (v: unknown): v is ThemeColor => THEME_COLORS.some((c) => c.name === v)

/** The CSS colour of a stored colour name; undefined for none or an unknown name (e.g. a hand-edited state.json). */
export const themeColorCss = (color: unknown): string | undefined => THEME_COLORS.find((c) => c.name === color)?.css

/** The longest icon accepted, in UTF-16 code units: room for a ZWJ pair or a flag, not for a sentence. */
export const MAX_THEME_ICON = 8

/** A small choice of common emoji for the Customize dialog. */
export const THEME_EMOJI: readonly string[] = [
  '🚀',
  '💼',
  '🏠',
  '🧪',
  '🛠️',
  '📚',
  '💡',
  '🎯',
  '🔥',
  '⭐',
  '🌱',
  '🐛',
  '🎨',
  '📦',
  '🔒',
  '🌐',
  '📱',
  '🤖',
  '🧠',
  '💰',
  '📈',
  '🎮',
  '🎵',
  '☕',
]

/** Code points that join or modify the one before them rather than starting a new character. */
const MODIFIER = /^(?:\u200d|\ufe0e|\ufe0f|\u20e3|[\u{1f3fb}-\u{1f3ff}]|[\u{e0020}-\u{e007f}])$/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/**
 * User-perceived characters in `s`: Intl.Segmenter's graphemes where available, otherwise an approximation that
 * keeps ZWJ sequences, variation selectors, skin tones, keycaps, tag sequences and flag pairs together.
 */
export function graphemeCount(s: string, useSegmenter = true): number {
  if (useSegmenter && segmenter) {
    return [...segmenter.segment(s)].length
  }
  let n = 0
  let joinNext = false
  let pendingFlag = false
  for (const ch of s) {
    const isFlag = /\p{Regional_Indicator}/u.test(ch)
    if (joinNext || MODIFIER.test(ch) || (isFlag && pendingFlag)) {
      joinNext = ch === '‍'
      pendingFlag = false
      continue
    }
    n++
    pendingFlag = isFlag
  }
  return n
}

/** Why `icon` can't be a theme icon, or null when it can ('' and whitespace mean "no icon"). */
export function themeIconError(icon: unknown): string | null {
  if (typeof icon !== 'string') return 'The icon must be an emoji'
  const text = icon.trim()
  if (text === '') return null
  if (CONTROL.test(text)) return 'The icon must be an emoji'
  if (text.length > MAX_THEME_ICON || graphemeCount(text) !== 1) return 'Use a single emoji'
  if (!PICTOGRAPHIC.test(text)) return 'Use an emoji, not a letter or symbol'
  return null
}

/**
 * A theme style as sent over IPC (so not trusted): only `color` (a THEME_COLORS name) and `icon` (one emoji,
 * trimmed). A field that is absent, null or '' means "none". Throws on anything else.
 */
export function normalizeThemeStyle(raw: unknown): ThemeStyle {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid theme style')
  const { color, icon } = raw as Record<string, unknown>
  const style: ThemeStyle = {}
  if (color !== undefined && color !== null && color !== '') {
    if (!isThemeColor(color)) throw new Error(`Unknown theme colour: ${String(color).slice(0, 40)}`)
    style.color = color
  }
  if (icon !== undefined && icon !== null) {
    const error = themeIconError(icon)
    if (error) throw new Error(error)
    const text = (icon as string).trim()
    if (text) style.icon = text
  }
  return style
}
