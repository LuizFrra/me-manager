import type { DiffHunk } from './parse'

/** One side of a split-diff row: a line of the old (left) or new (right) file, or a "\ No newline…" note. */
export interface SplitCell {
  kind: 'context' | 'del' | 'add' | 'note'
  text: string
  /** The line number on this side; notes have none. */
  no?: number
}

/** A row of the side-by-side view. A null side is padding: that side has no line here. */
export interface SplitRow {
  left: SplitCell | null
  right: SplitCell | null
}

export interface SplitHunk {
  header: string
  rows: SplitRow[]
}

/** A deleted or added line waiting to be paired, with the note that followed it, if any. */
interface Pending {
  cell: SplitCell
  note?: SplitCell
}

/**
 * Lays a hunk out side by side, old on the left and new on the right. Context lines show on both sides. In each
 * block of changes (the deletions and additions between two context lines), the n-th deletion is paired with the
 * n-th addition and the shorter side is padded with empty cells. A "\ No newline at end of file" note goes on its
 * line's side, in a row of its own right after that line's row; after a context line, on both sides.
 */
export function splitHunk(hunk: DiffHunk): SplitHunk {
  const rows: SplitRow[] = []
  let dels: Pending[] = []
  let adds: Pending[] = []
  // Where a note that comes next belongs: a pending change, or (null) the context row just pushed.
  let last: Pending | null = null

  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const del = dels[i]
      const add = adds[i]
      rows.push({ left: del?.cell ?? null, right: add?.cell ?? null })
      if (del?.note || add?.note) rows.push({ left: del?.note ?? null, right: add?.note ?? null })
    }
    dels = []
    adds = []
  }

  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      flush()
      rows.push({
        left: { kind: 'context', text: line.text, no: line.oldNo },
        right: { kind: 'context', text: line.text, no: line.newNo },
      })
      last = null
    } else if (line.kind === 'del') {
      // git writes a block's deletions before its additions; a deletion after additions starts a new block.
      if (adds.length > 0) flush()
      last = { cell: { kind: 'del', text: line.text, no: line.oldNo } }
      dels.push(last)
    } else if (line.kind === 'add') {
      last = { cell: { kind: 'add', text: line.text, no: line.newNo } }
      adds.push(last)
    } else {
      const note: SplitCell = { kind: 'note', text: line.text }
      if (last) last.note = note
      else rows.push({ left: note, right: { ...note } })
    }
  }
  flush()
  return { header: hunk.header, rows }
}

export const splitHunks = (hunks: readonly DiffHunk[]): SplitHunk[] => hunks.map(splitHunk)
