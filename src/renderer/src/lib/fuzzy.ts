/**
 * Fuzzy subsequence matching for the command palette.
 *
 * Every query character must appear in the text, in order (ignoring case and accents, so "acao" finds "ação";
 * whitespace in the query is ignored).
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

/** Below this, code units fold through a table (ASCII, Latin-1 and Latin Extended, where accents live). */
const TABLE_END = 0x250
let foldTable: Uint16Array | undefined
const foldedBeyond = new Map<number, number>()

function foldSlow(code: number): number {
  // Its first character once decomposed is the letter without its accent: "ç" is "c" + U+0327.
  const base = String.fromCharCode(code).normalize('NFD')[0].toLowerCase()
  return base.length === 1 ? base.charCodeAt(0) : code
}

/**
 * A UTF-16 code unit as matching compares it: lowercased, without its accent. One unit in, one out, so positions
 * in the folded text are positions in the text.
 */
function fold(code: number): number {
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? code + 0x20 : code
  if (code < TABLE_END) {
    if (!foldTable) {
      foldTable = new Uint16Array(TABLE_END)
      for (let c = 0; c < TABLE_END; c++) foldTable[c] = foldSlow(c)
    }
    return foldTable[code]
  }
  let folded = foldedBeyond.get(code)
  if (folded === undefined) {
    folded = foldSlow(code)
    foldedBeyond.set(code, folded)
  }
  return folded
}

/** `text` as searches compare it: lowercased and without accents ("Ação" is "acao"). */
export function foldText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // A decomposed accent (a combining mark on its own) is dropped.
    if (code < 0x300 || code > 0x36f) out += String.fromCharCode(fold(code))
  }
  return out
}

/** The query's code units, folded; whitespace and combining accents (U+0300–U+036F) left out. */
function queryChars(query: string): number[] {
  const chars: number[] = []
  for (let i = 0; i < query.length; i++) {
    const code = query.charCodeAt(i)
    if ((code < 0x300 || code > 0x36f) && !/\s/.test(query[i])) chars.push(fold(code))
  }
  return chars
}

/** The best match of `query` in `text`, or null if the query is not a subsequence. An empty query matches. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = queryChars(query)
  if (q.length === 0) return { score: 0, positions: [] }
  const positions: number[] = new Array(q.length)
  const score = matchChars(q, text, positions)
  return score === -Infinity ? null : { score, positions }
}

// Buffers for every call, grown as needed: the palette matches up to 50,000 paths per keystroke, and a one-letter
// query matches most of them. The folded text being matched, then the n × m score tables (see matchChars).
let foldedText = new Uint16Array(256)
let scoreTable = new Float64Array(1024)
let runTable = new Float64Array(1024)
let fromTable = new Int32Array(1024)

/**
 * The best score of the folded query `q` (not empty) in `text`, or -Infinity if it is not a subsequence. With
 * `positions`, also fills it with where each query character matched.
 */
function matchChars(q: readonly number[], text: string, positions?: number[]): number {
  const n = q.length
  const m = text.length
  if (n > m) return -Infinity
  if (foldedText.length < m) foldedText = new Uint16Array(m * 2)
  const lower = foldedText

  // Cheap rejection first, while folding: most candidates are not subsequence matches at all.
  let qi = 0
  let at = 0
  for (; at < m && qi < n; at++) {
    lower[at] = fold(text.charCodeAt(at))
    if (lower[at] === q[qi]) qi++
  }
  if (qi < n) return -Infinity
  for (; at < m; at++) lower[at] = fold(text.charCodeAt(at))

  // score[i * m + j]: best score with query char i matched at text position j; from[] remembers where i-1 went.
  // A consecutive run carries the bonus of its first character, so all of "app" in "src/app.ts" counts as a
  // word-start match rather than only the "a". Only score[] needs resetting: the others are read where it is set.
  if (scoreTable.length < n * m) {
    scoreTable = new Float64Array(n * m * 2)
    runTable = new Float64Array(n * m * 2)
    fromTable = new Int32Array(n * m * 2)
  }
  const score = scoreTable.fill(-Infinity, 0, n * m)
  const runBonus = runTable
  const from = fromTable

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
      const prev = score[prevRow + j - 1]
      if (prev === -Infinity && gapBest === -Infinity) continue // unreachable: skip the bonus lookup
      const gapCost = PENALTY_GAP_EXTENSION * (j - 1) + (PENALTY_GAP_START - PENALTY_GAP_EXTENSION)
      const own = boundaryBonus(text, j)
      const carried = Math.max(own, runBonus[prevRow + j - 1], BONUS_CONSECUTIVE)
      const consecutive = prev + SCORE_MATCH + carried
      const gapped = gapBest - gapCost + SCORE_MATCH + own
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
  if (end === -1 || score[last + end] === -Infinity) return -Infinity
  if (positions) {
    for (let i = n - 1, j = end; i >= 0; i--) {
      positions[i] = j
      j = from[i * m + j]
    }
  }
  return score[last + end] - PENALTY_LENGTH * m
}

/**
 * The items whose text matches `query`, best first (ties keep their original order), at most `limit`.
 * An empty query returns the first `limit` items unchanged.
 *
 * Only scores are computed while scanning, and only the best `limit` are kept; the match positions are found for
 * those alone. A small limit keeps a query that matches most of 50,000 paths cheap.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit = Infinity,
): FuzzyResult<T>[] {
  const q = queryChars(query)
  if (q.length === 0) return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }))
  // The matches kept, best first, by index and score: all of them when the limit cuts none, else the best so far,
  // each placed after those scoring at least as much, so ties keep their original order.
  const best: number[] = []
  const bestScore: number[] = []
  if (limit >= items.length) {
    const scores = new Float64Array(items.length)
    for (let index = 0; index < items.length; index++) {
      scores[index] = matchChars(q, text(items[index]))
      if (scores[index] !== -Infinity) best.push(index)
    }
    best.sort((a, b) => scores[b] - scores[a] || a - b)
    for (const index of best) bestScore.push(scores[index])
  } else
    for (let index = 0; index < items.length; index++) {
      const s = matchChars(q, text(items[index]))
      if (s === -Infinity || (best.length >= limit && s <= bestScore[best.length - 1])) continue
      let lo = 0
      let hi = best.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (bestScore[mid] >= s) lo = mid + 1
        else hi = mid
      }
      best.splice(lo, 0, index)
      bestScore.splice(lo, 0, s)
      if (best.length > limit) {
        best.pop()
        bestScore.pop()
      }
    }
  return best.map((index, rank) => {
    const item = items[index]
    const positions: number[] = new Array(q.length)
    matchChars(q, text(item), positions)
    return { item, score: bestScore[rank], positions }
  })
}
