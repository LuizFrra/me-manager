/** Where a removed entry sat: its neighbours' ids and its index, for putting it back with "Undo". */
export interface Place {
  before?: string
  after?: string
  index: number
}

/** The place of the entry at `index` in `ids`. */
export function placeOf(ids: readonly string[], index: number): Place {
  return { before: ids[index - 1], after: ids[index + 1], index }
}

/**
 * The index to put an entry back at, in the list as it is now: right after the entry that preceded it, or else
 * right before the one that followed it, or else (both gone too) at its old index. The old index alone goes
 * wrong once the list has changed: removing A then B from [A, B, C] and undoing A then B would give [B, A, C].
 */
export function placeBack(ids: readonly string[], place: Place): number {
  const before = place.before === undefined ? -1 : ids.indexOf(place.before)
  if (before !== -1) return before + 1
  const after = place.after === undefined ? -1 : ids.indexOf(place.after)
  if (after !== -1) return after
  return Math.min(place.index, ids.length)
}
