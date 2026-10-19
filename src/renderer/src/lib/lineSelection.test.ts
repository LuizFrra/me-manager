import { describe, expect, it } from 'vitest'
import { clickSelection, selectionBounds, selectionKey, type LineSelection } from './lineSelection'
import type { KeyLike } from './shortcuts'

const key = (
  k: string,
  mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
): KeyLike => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})
const sel = (anchor: number, focus = anchor): LineSelection => ({ anchor, focus })

describe('clickSelection', () => {
  it('selects the clicked line, and Shift extends from the first one either way', () => {
    expect(clickSelection(null, 4, false)).toEqual(sel(4))
    expect(clickSelection(sel(4), 9, true)).toEqual(sel(4, 9))
    expect(clickSelection(sel(4, 9), 1, true)).toEqual(sel(4, 1))
    expect(clickSelection(sel(4, 9), 6, false)).toEqual(sel(6))
    expect(clickSelection(null, 3, true)).toEqual(sel(3))
  })

  it('unselects the only selected line when it is clicked again', () => {
    expect(clickSelection(sel(4), 4, false)).toBeNull()
    expect(clickSelection(sel(4, 5), 4, false)).toEqual(sel(4))
  })
})

describe('selectionBounds', () => {
  it('orders the ends', () => {
    expect(selectionBounds(sel(9, 4))).toEqual([4, 9])
    expect(selectionBounds(sel(2, 3))).toEqual([2, 3])
  })
})

describe('selectionKey', () => {
  it('moves a one-line selection with the arrows, starting at either end, clamped', () => {
    expect(selectionKey(key('ArrowDown'), null, 10)).toEqual({ kind: 'select', selection: sel(0) })
    expect(selectionKey(key('ArrowUp'), null, 10)).toEqual({ kind: 'select', selection: sel(9) })
    expect(selectionKey(key('ArrowDown'), sel(2, 5), 10)).toEqual({ kind: 'select', selection: sel(6) })
    expect(selectionKey(key('ArrowDown'), sel(9), 10)).toEqual({ kind: 'select', selection: sel(9) })
    expect(selectionKey(key('ArrowUp'), sel(0), 10)).toEqual({ kind: 'select', selection: sel(0) })
    expect(selectionKey(key('Home'), sel(5), 10)).toEqual({ kind: 'select', selection: sel(0) })
    expect(selectionKey(key('End'), sel(5), 10)).toEqual({ kind: 'select', selection: sel(9) })
  })

  it('extends the selection with Shift', () => {
    expect(selectionKey(key('ArrowDown', { shiftKey: true }), sel(2), 10)).toEqual({
      kind: 'select',
      selection: sel(2, 3),
    })
    expect(selectionKey(key('ArrowUp', { shiftKey: true }), sel(2, 3), 10)).toEqual({
      kind: 'select',
      selection: sel(2),
    })
    expect(selectionKey(key('End', { shiftKey: true }), sel(2), 10)).toEqual({ kind: 'select', selection: sel(2, 9) })
  })

  it('comments with C or Enter, and Escape clears, only with lines selected', () => {
    expect(selectionKey(key('c'), sel(1), 10)).toEqual({ kind: 'comment' })
    expect(selectionKey(key('C'), sel(1), 10)).toEqual({ kind: 'comment' })
    expect(selectionKey(key('Enter'), sel(1), 10)).toEqual({ kind: 'comment' })
    expect(selectionKey(key('Escape'), sel(1), 10)).toEqual({ kind: 'select', selection: null })
    expect(selectionKey(key('c'), null, 10)).toBeNull()
    expect(selectionKey(key('Escape'), null, 10)).toBeNull()
  })

  it('leaves other keys, chords and empty views alone', () => {
    expect(selectionKey(key('x'), sel(1), 10)).toBeNull()
    expect(selectionKey(key('c', { ctrlKey: true }), sel(1), 10)).toBeNull()
    expect(selectionKey(key('ArrowDown', { metaKey: true }), sel(1), 10)).toBeNull()
    expect(selectionKey(key('ArrowDown', { altKey: true }), sel(1), 10)).toBeNull()
    expect(selectionKey(key('ArrowDown'), null, 0)).toBeNull()
  })
})
