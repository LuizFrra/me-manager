/**
 * Fuzzy subsequence matching for the command palette.
 *
 * Every query character must appear in the text, in order (case-insensitive; whitespace in the query is ignored).
 * Among all the ways to place the query in the text, the best-scoring one wins: matches at word starts
 * (after a separator or at a camelCase hump) and runs of consecutive matches score higher, gaps cost a little.
 */

export interface FuzzyMatch {
  score: number
  /** Indexes into the text of the matched characters, ascending. */
  positions: number[]
}

export interface FuzzyResult<T> extends FuzzyMatch {
  item: T
}

// Weights in the spirit of fzf: a match is worth 16; word starts and consecutive runs add to it, gaps cost.
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 7
const BONUS_CONSECUTIVE = 4
/** The first query character's bonus counts double, so a query that starts at a word start ranks high. */
const FIRST_CHAR_MULTIPLIER = 2
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1
/** A tie-breaker: shorter texts rank first. */
const PENALTY_LENGTH = 0.001

const SEPARATORS = new Set([' ', '/', '\\', '-', '_', '.', ':', '›', '(', '[', '@'])

const isLower = (c: string): boolean => c !== c.toUpperCase() && c === c.toLowerCase()
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase()

/** The bonus for a match at text[i]: word starts (after a separator, or a camelCase hump) earn more. */
function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BONUS_BOUNDARY
  const prev = text[i - 1]
  if (SEPARATORS.has(prev)) return BONUS_BOUNDARY
  return isLower(prev) && isUpper(text[i]) ? BONUS_CAMEL : 0
}

/** The query's characters, lowercased one UTF-16 unit at a time so indexes line up with the text. */
function queryChars(query: string): string[] {
  const chars: string[] = []
  for (const c of query) if (!/\s/.test(c)) chars.push(...c.toLowerCase().split(''))
  return chars
}

/** The best match of `query` in `text`, or null if the query is not a subsequence. An empty query matches. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  return matchChars(queryChars(query), text)
}

function matchChars(q: string[], text: string): FuzzyMatch | null {
  const n = q.length
  const m = text.length
  if (n === 0) return { score: 0, positions: [] }
  if (n > m) return null
  const lower: string[] = new Array(m)
  for (let j = 0; j < m; j++) lower[j] = text[j].toLowerCase()

  // Cheap rejection first: most candidates are not subsequence matches at all.
  let qi = 0
  for (let j = 0; j < m && qi < n; j++) if (lower[j] === q[qi]) qi++
  if (qi < n) return null

  // score[i * m + j]: best score with query char i matched at text position j; from[] remembers where i-1 went.
  // A consecutive run carries the bonus of its first character, so all of "app" in "src/app.ts" counts as a
  // word-start match rather than only the "a".
  const score = new Float64Array(n * m).fill(-Infinity)
  const runBonus = new Float64Array(n * m)
  const from = new Int32Array(n * m).fill(-1)

  for (let j = 0; j < m; j++) {
    if (lower[j] !== q[0]) continue
    const bonus = boundaryBonus(text, j)
    score[j] = SCORE_MATCH + bonus * FIRST_CHAR_MULTIPLIER
    runBonus[j] = bonus
  }

  for (let i = 1; i < n; i++) {
    const row = i * m
    const prevRow = row - m
    // A gap of g characters costs START + EXTENSION * (g - 1). Track the best score[i-1][k] + EXTENSION * k
    // over k <= j - 2, so the best gapped predecessor is found in one pass.
    let gapBest = -Infinity
    let gapFrom = -1
    for (let j = i; j < m; j++) {
      const k = j - 2
      if (k >= 0 && score[prevRow + k] + PENALTY_GAP_EXTENSION * k > gapBest) {
        gapBest = score[prevRow + k] + PENALTY_GAP_EXTENSION * k
        gapFrom = k
      }
      if (lower[j] !== q[i]) continue
      const own = boundaryBonus(text, j)
      const prev = score[prevRow + j - 1]
      const carried = Math.max(own, runBonus[prevRow + j - 1], BONUS_CONSECUTIVE)
      const consecutive = prev + SCORE_MATCH + carried
      const gapped =
        gapBest - PENALTY_GAP_EXTENSION * (j - 1) - (PENALTY_GAP_START - PENALTY_GAP_EXTENSION) + SCORE_MATCH + own
      if (consecutive === -Infinity && gapped === -Infinity) continue
      if (consecutive >= gapped) {
        score[row + j] = consecutive
        runBonus[row + j] = carried
        from[row + j] = j - 1
      } else {
        score[row + j] = gapped
        runBonus[row + j] = own
        from[row + j] = gapFrom
      }
    }
  }

  const last = (n - 1) * m
  let end = -1
  for (let j = n - 1; j < m; j++) if (end === -1 || score[last + j] > score[last + end]) end = j
  if (end === -1 || score[last + end] === -Infinity) return null
  const positions: number[] = new Array(n)
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions[i] = j
    j = from[i * m + j]
  }
  return { score: score[last + end] - PENALTY_LENGTH * m, positions }
}

/**
 * The items whose text matches `query`, best first (ties keep their original order), at most `limit`.
 * An empty query returns the first `limit` items unchanged.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit = Infinity,
): FuzzyResult<T>[] {
  const q = queryChars(query)
  if (q.length === 0) return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }))
  const results: (FuzzyResult<T> & { index: number })[] = []
  items.forEach((item, index) => {
    const match = matchChars(q, text(item))
    if (match) results.push({ item, index, ...match })
  })
  results.sort((a, b) => b.score - a.score || a.index - b.index)
  return results.slice(0, limit).map(({ item, score, positions }) => ({ item, score, positions }))
}
