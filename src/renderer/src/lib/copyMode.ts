import type { IBufferLine } from '@xterm/xterm'

/** tmux's position in copy mode, `[12/345]`: how many lines the view is scrolled back, of the history's lines. */
const POSITION = /^\[(\d+)\/(\d+)\]$/

/**
 * The position tmux shows at the end of `line` (the top row of the screen) while it is in copy mode: `[n/m]` against
 * the right edge, in a highlight colour (its mode-style) that ordinary output there would not share. `scrolledBack`
 * is 0 at the bottom (copy mode entered by a mouse selection). Null when it isn't there: not in copy mode.
 */
export function copyModePosition(line: IBufferLine): { scrolledBack: number } | null {
  let x = line.length - 1
  let text = ''
  for (; x >= 0 && text.length <= 16; x--) {
    const cell = line.getCell(x)
    if (!cell || cell.isBgDefault()) break
    text = cell.getChars() + text
  }
  const m = POSITION.exec(text)
  return m ? { scrolledBack: Number(m[1]) } : null
}
