import type { KeyLike } from './shortcuts'

/**
 * Selected lines of the code view or a diff, by row index (0-based, among the rows that can be selected): where
 * the selection started, which Shift extends from, and where it ends now. Either may come first.
 */
export interface LineSelection {
  anchor: number
  focus: number
}

/** The first and last selected row. */
export const selectionBounds = ({ anchor, focus }: LineSelection): [number, number] =>
  anchor <= focus ? [anchor, focus] : [focus, anchor]

/**
 * A click on row `index`'s line number: selects that line, or with Shift extends the selection from its anchor.
 * Clicking the only selected line again unselects it.
 */
export function clickSelection(prev: LineSelection | null, index: number, shift: boolean): LineSelection | null {
  if (shift && prev) return { anchor: prev.anchor, focus: index }
  if (!shift && prev?.anchor === index && prev.focus === index) return null
  return { anchor: index, focus: index }
}

export type SelectionKeyResult = { kind: 'select'; selection: LineSelection | null } | { kind: 'comment' }

/**
 * A key pressed in the line numbers (`count` rows): ↑/↓/Home/End move a one-line selection (from the last row
 * moved to; the first or last row when nothing is selected), and with Shift extend it; with lines selected, C or
 * Enter comments on them and Escape clears them. null: not a selection key, left to the browser.
 */
export function selectionKey(e: KeyLike, prev: LineSelection | null, count: number): SelectionKeyResult | null {
  if (e.ctrlKey || e.metaKey || e.altKey || count === 0) return null
  if (prev && (e.key === 'Enter' || e.key.toLowerCase() === 'c')) return { kind: 'comment' }
  if (e.key === 'Escape') return prev ? { kind: 'select', selection: null } : null
  const last = count - 1
  const from = prev?.focus
  const to: Record<string, number> = {
    ArrowDown: from === undefined ? 0 : from + 1,
    ArrowUp: from === undefined ? last : from - 1,
    Home: 0,
    End: last,
  }
  if (!(e.key in to)) return null
  const focus = Math.min(Math.max(to[e.key], 0), last)
  return { kind: 'select', selection: e.shiftKey && prev ? { anchor: prev.anchor, focus } : { anchor: focus, focus } }
}
