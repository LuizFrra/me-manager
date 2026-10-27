import type { IBufferCell, IBufferLine } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { copyModePosition } from './copyMode'

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

describe('copyModePosition', () => {
  it("finds tmux's highlighted [n/m] against the right edge", () => {
    expect(copyModePosition(row('output   [12/345]', 30, 8))).toEqual({ scrolledBack: 12 })
    expect(copyModePosition(row('output [0/345]', 30, 7))).toEqual({ scrolledBack: 0 })
    // a selection on the same row has the same highlight
    expect(copyModePosition(row('selected text[0/345]', 30, 20))).toEqual({ scrolledBack: 0 })
  })

  it('ignores the same text printed as ordinary output, or anything else highlighted', () => {
    expect(copyModePosition(row('progress [12/345]', 30, 0))).toBeNull()
    expect(copyModePosition(row('   a highlighted status', 30, 10))).toBeNull()
    expect(copyModePosition(row('', 30, 0))).toBeNull()
  })
})
