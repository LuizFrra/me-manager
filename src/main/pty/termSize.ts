/** The largest window tmux takes (its WINDOW_MAXIMUM): anything bigger is a bug, not a screen. */
const MAX_TERM_SIZE = 10_000

/** A size a terminal can take: a whole number from 2 (smaller ones are a hidden or collapsed terminal) to MAX_TERM_SIZE. */
export const isTermSize = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 2 && n <= MAX_TERM_SIZE
