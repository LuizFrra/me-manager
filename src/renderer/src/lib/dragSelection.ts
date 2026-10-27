/** A terminal cell on the screen, 0-based. */
export interface Cell {
  col: number
  row: number
}

/** The cell under a pointer at (x, y) on a screen of `cols` x `rows` cells; outside it, the nearest edge cell. */
export function cellAt(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  cols: number,
  rows: number,
  x: number,
  y: number,
): Cell | null {
  if (rect.width <= 0 || rect.height <= 0 || cols <= 0 || rows <= 0) return null
  const clamp = (n: number, max: number): number => Math.min(max - 1, Math.max(0, Math.floor(n)))
  return {
    col: clamp(((x - rect.left) / rect.width) * cols, cols),
    row: clamp(((y - rect.top) / rect.height) * rows, rows),
  }
}

/**
 * What a drag from `a` to `b` selects, in either direction: the cells from the first to the last, both included, running
 * on across lines (as tmux's copy mode selects). In the arguments of xterm's `select(column, row, length)`, with the
 * row on the screen.
 */
export function dragRange(a: Cell, b: Cell, cols: number): { column: number; row: number; length: number } {
  const [first, last] = a.row * cols + a.col <= b.row * cols + b.col ? [a, b] : [b, a]
  return {
    column: first.col,
    row: first.row,
    length: last.row * cols + last.col - (first.row * cols + first.col) + 1,
  }
}
