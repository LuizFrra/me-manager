import type { IUnicodeVersionProvider } from '@xterm/xterm'
import { WIDE, ZERO_WIDTH } from './unicodeWidthTable'

/** Whether `cp` falls in one of the flattened inclusive ranges (see unicodeWidthTable). */
function inRanges(cp: number, ranges: readonly number[]): boolean {
  let lo = 0
  let hi = ranges.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < ranges[mid * 2]) hi = mid - 1
    else if (cp > ranges[mid * 2 + 1]) lo = mid + 1
    else return true
  }
  return false
}

// The Basic Multilingual Plane, looked up rather than searched: almost every character printed is in it.
let bmp: Uint8Array | null = null
function bmpTable(): Uint8Array {
  const table = new Uint8Array(0x10000).fill(1)
  table.fill(0, 0, 0x20) // C0 controls
  table.fill(0, 0x7f, 0xa0) // DEL and C1 controls
  for (const [ranges, width] of [
    [ZERO_WIDTH, 0],
    [WIDE, 2],
  ] as const)
    for (let i = 0; i < ranges.length && ranges[i] < 0x10000; i += 2)
      table.fill(width, ranges[i], Math.min(ranges[i + 1], 0xffff) + 1)
  return table
}

/** The cells a code point takes on its own, as the system's wcwidth (and so tmux) counts them. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x10000) return ((bmp ??= bmpTable())[cp] ?? 1) as 0 | 1 | 2
  if (inRanges(cp, ZERO_WIDTH)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

const ZWJ = 0x200d
const VS16 = 0xfe0f
const isSkinTone = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff
/** Kept in the state bits of a character's properties: it was a zero-width joiner. */
const AFTER_ZWJ = 1

// xterm's packing of character properties (UnicodeService.createPropertyValue): state, width, join flag.
const pack = (state: number, width: number, join: boolean): number => (state << 3) | ((width & 3) << 1) | (join ? 1 : 0)
const widthOf = (props: number): number => (props >> 1) & 3

/**
 * Character widths that agree with tmux, which measures with the system's wcwidth. xterm's built-in table is
 * Unicode 6, where emoji take one cell: tmux gives them two, so every emoji shifted the rest of its line.
 * Like tmux, an emoji sequence is one character: an emoji presentation selector (U+FE0F) makes the character
 * before it two cells wide, and a skin tone or a character after a zero-width joiner joins the one before.
 */
export const SYSTEM_UNICODE: IUnicodeVersionProvider = {
  version: 'system',
  wcwidth: charWidth,
  charProperties(cp, preceding) {
    let width: number = charWidth(cp)
    const before = widthOf(preceding)
    let join = false
    if (before > 0) {
      if (width === 0) {
        join = true
        width = cp === VS16 ? 2 : before
      } else if ((preceding >> 3) & AFTER_ZWJ || (isSkinTone(cp) && before === 2)) {
        join = true
        width = Math.max(width, before)
      }
    }
    return pack(cp === ZWJ ? AFTER_ZWJ : 0, width, join)
  },
}

/** The cells `text` takes, counted the way xterm counts with `provider`. */
export function stringWidth(text: string, provider: IUnicodeVersionProvider = SYSTEM_UNICODE): number {
  let total = 0
  let preceding = 0
  for (const ch of text) {
    const props = provider.charProperties(ch.codePointAt(0) as number, preceding)
    total += widthOf(props) - (props & 1 ? widthOf(preceding) : 0)
    preceding = props
  }
  return total
}
