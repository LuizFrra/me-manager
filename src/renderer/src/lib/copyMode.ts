import type { IBufferLine } from '@xterm/xterm'

/** tmux's position in copy mode, `[12/345]`: the line scrolled back to, of the history's lines. */
const POSITION = /^\[\d+\/\d+\]$/

/**
 * Whether `line` (the top row of the screen) ends with the position tmux shows while it is in copy mode: `[n/m]`
 * against the right edge, in a highlight colour (its mode-style) that ordinary output there would not share.
 */
export function showsCopyModePosition(line: IBufferLine): boolean {
  let x = line.length - 1
  let text = ''
  for (; x >= 0 && text.length <= 16; x--) {
    const cell = line.getCell(x)
    if (!cell || cell.isBgDefault()) break
    text = cell.getChars() + text
  }
  return POSITION.test(text)
}
