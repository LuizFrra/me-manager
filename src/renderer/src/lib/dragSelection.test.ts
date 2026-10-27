import { describe, expect, it } from 'vitest'
import { cellAt, dragRange } from './dragSelection'

describe('cellAt', () => {
  const rect = { left: 10, top: 20, width: 800, height: 480 } // 80 x 24 cells of 10 x 20 px

  it('finds the cell under the pointer', () => {
    expect(cellAt(rect, 80, 24, 10, 20)).toEqual({ col: 0, row: 0 })
    expect(cellAt(rect, 80, 24, 35, 61)).toEqual({ col: 2, row: 2 })
  })

  it('keeps a pointer outside the screen on its edge cells', () => {
    expect(cellAt(rect, 80, 24, 0, 0)).toEqual({ col: 0, row: 0 })
    expect(cellAt(rect, 80, 24, 2000, 2000)).toEqual({ col: 79, row: 23 })
  })

  it('finds nothing on a screen with no size', () => {
    expect(cellAt({ left: 0, top: 0, width: 0, height: 0 }, 80, 24, 5, 5)).toBeNull()
  })
})

describe('dragRange', () => {
  it('covers both end cells, as tmux copies them', () => {
    expect(dragRange({ col: 1, row: 2 }, { col: 7, row: 2 }, 80)).toEqual({ column: 1, row: 2, length: 7 })
  })

  it('is the same dragged backwards or upwards', () => {
    expect(dragRange({ col: 7, row: 2 }, { col: 1, row: 2 }, 80)).toEqual({ column: 1, row: 2, length: 7 })
    expect(dragRange({ col: 3, row: 5 }, { col: 78, row: 4 }, 80)).toEqual({ column: 78, row: 4, length: 6 })
  })

  it('runs on across lines, from the start cell to the end cell', () => {
    expect(dragRange({ col: 70, row: 0 }, { col: 9, row: 2 }, 80)).toEqual({ column: 70, row: 0, length: 100 })
  })
})
