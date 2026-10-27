import type { IBufferCell, IBufferLine } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { showsCopyModePosition } from './copyMode'

/** A row of `cols` cells; the last `highlighted` of them have a coloured background. */
function row(text: string, cols: number, highlighted: number): IBufferLine {
  const chars = [...text.padStart(cols)]
  return {
    length: cols,
    getCell: (x: number) =>
      ({
        getChars: () => (chars[x] === ' ' ? '' : chars[x]),
        isBgDefault: () => x < cols - highlighted,
      }) as IBufferCell,
  } as unknown as IBufferLine
}

describe('showsCopyModePosition', () => {
  it("finds tmux's highlighted [n/m] against the right edge", () => {
    expect(showsCopyModePosition(row('output   [12/345]', 30, 8))).toBe(true)
  })

  it('ignores the same text printed as ordinary output, or anything else highlighted', () => {
    expect(showsCopyModePosition(row('progress [12/345]', 30, 0))).toBe(false)
    expect(showsCopyModePosition(row('   a highlighted status', 30, 10))).toBe(false)
    expect(showsCopyModePosition(row('', 30, 0))).toBe(false)
  })
})
