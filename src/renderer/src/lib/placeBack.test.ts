import { describe, expect, it } from 'vitest'
import { placeBack, placeOf } from './placeBack'

/** Removes `id` from `list`, returning its place and the list without it. */
const remove = (list: string[], id: string): { place: ReturnType<typeof placeOf>; rest: string[] } => ({
  place: placeOf(list, list.indexOf(id)),
  rest: list.filter((x) => x !== id),
})
const putBack = (list: string[], id: string, place: ReturnType<typeof placeOf>): string[] => {
  const next = [...list]
  next.splice(placeBack(list, place), 0, id)
  return next
}

describe('placeBack', () => {
  it('restores two removals in either undo order', () => {
    const a = remove(['A', 'B', 'C'], 'A')
    const b = remove(a.rest, 'B')
    expect(b.rest).toEqual(['C'])
    expect(putBack(putBack(b.rest, 'A', a.place), 'B', b.place)).toEqual(['A', 'B', 'C'])
    expect(putBack(putBack(b.rest, 'B', b.place), 'A', a.place)).toEqual(['A', 'B', 'C'])
  })

  it('restores the ends of a list', () => {
    const a = remove(['A', 'B', 'C'], 'A')
    const c = remove(a.rest, 'C')
    expect(putBack(putBack(c.rest, 'A', a.place), 'C', c.place)).toEqual(['A', 'B', 'C'])
    expect(putBack(putBack(c.rest, 'C', c.place), 'A', a.place)).toEqual(['A', 'B', 'C'])
  })

  it('falls back to the old index, within the list, when both neighbours are gone', () => {
    expect(placeBack(['X', 'Y'], { before: 'gone', after: 'also gone', index: 1 })).toBe(1)
    expect(placeBack(['X'], { index: 5 })).toBe(1)
    expect(placeBack([], { index: 0 })).toBe(0)
  })
})
