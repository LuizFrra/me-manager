import type { PanelTabName } from '../../../shared/types'
import type { DiffLine } from './diff/parse'

/** Lines of a file, 1-based, both ends included. */
export interface LineRange {
  start: number
  end: number
}

/**
 * The lines a selection covers. In the file viewer, `lines` only. In a diff, added and unchanged lines are in
 * `lines`, by their number in the file as it is now (the diff's new side), and deleted lines in `removed`, by
 * their number in the old version (the base), as they aren't in the file any more.
 */
export interface SelectedLines {
  lines?: LineRange
  removed?: LineRange
}

/** What a review comment is about: some lines of a file (root-relative path). */
export interface ReviewAnchor extends SelectedLines {
  path: string
}

/** A note on some lines, kept in the renderer per task or folder until it is sent to Claude. */
export interface ReviewComment extends ReviewAnchor {
  id: number
  /** Where it was made: the file viewer (Files) or a diff (Changes), to open it there again. */
  tab: Extract<PanelTabName, 'files' | 'changes'>
  note: string
}

/** The longest note a review comment takes. */
export const MAX_REVIEW_NOTE = 5_000

/** The first line of the message a review becomes. */
export const REVIEW_INTRO = 'Please address these review comments:'

const span = ({ start, end }: LineRange, sep = '-'): string => (start === end ? `${start}` : `${start}${sep}${end}`)
const removedText = (r: LineRange, sep = '-'): string => `removed line${r.start === r.end ? '' : 's'} ${span(r, sep)}`

/**
 * Where a comment points, for Claude: `src/app.ts:12-15`, `README.md:3`, `a.ts (removed lines 7-9)` for deleted
 * lines alone, or `a.ts:7-8 (and removed line 7)` for a diff selection with both.
 */
export function reviewLocation({ path, lines, removed }: ReviewAnchor): string {
  const at = lines ? `${path}:${span(lines)}` : path
  if (!removed) return at
  return lines ? `${at} (and ${removedText(removed)})` : `${at} (${removedText(removed)})`
}

/**
 * The comments as one message for Claude: REVIEW_INTRO, then each comment's location and note, in the order they
 * were made, separated by blank lines. '' without comments.
 */
export function formatReview(comments: readonly ReviewComment[]): string {
  if (comments.length === 0) return ''
  return [REVIEW_INTRO, ...comments.map((c) => `${reviewLocation(c)}\n${c.note.trim()}`)].join('\n\n')
}

/** The lines a set of selected diff lines covers (see SelectedLines); notes count for nothing. */
export function diffLinesRange(selected: readonly DiffLine[]): SelectedLines {
  const grow = (range: LineRange | undefined, n: number): LineRange =>
    range ? { start: Math.min(range.start, n), end: Math.max(range.end, n) } : { start: n, end: n }
  const out: SelectedLines = {}
  for (const line of selected) {
    if (line.kind === 'del' && line.oldNo !== undefined) out.removed = grow(out.removed, line.oldNo)
    else if (line.kind !== 'note' && line.newNo !== undefined) out.lines = grow(out.lines, line.newNo)
  }
  return out
}

/** The selection as the viewer describes it: "Lines 4–9", "Removed line 2", "Line 4 and removed lines 2–3". */
export function selectedLinesLabel({ lines, removed }: SelectedLines): string {
  const parts: string[] = []
  if (lines) parts.push(`Line${lines.start === lines.end ? '' : 's'} ${span(lines, '–')}`)
  if (removed) parts.push(removedText(removed, '–'))
  const text = parts.join(' and ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
