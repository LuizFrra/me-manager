/**
 * Claude API prices, in USD per million tokens, used to estimate what Claude Code usage would cost on the API.
 *
 * Source: the official Claude API pricing in the claude-api reference, as cached on 2026-09-25. Update the table
 * (and PRICING_SOURCE_DATE) when prices change; unknown models still count their tokens, just without a cost.
 */
export const PRICING_SOURCE_DATE = '2026-09-25'

export interface ModelPrice {
  /** Base input tokens. Cache writes are priced from this: 5-minute writes 1.25×, 1-hour writes 2×. */
  input: number
  output: number
  cacheRead: number
}

export const CACHE_WRITE_5M_MULTIPLIER = 1.25
export const CACHE_WRITE_1H_MULTIPLIER = 2
/** Fast mode (`usage.speed === 'fast'`) bills the whole message at this multiple. */
export const FAST_MODE_MULTIPLIER = 2

const price = (input: number, output: number, cacheRead: number): ModelPrice => ({ input, output, cacheRead })

/** Model id prefixes and their prices. Matching tries the longest prefix first (see priceForModel). */
export const MODEL_PRICES: readonly { prefix: string; price: ModelPrice }[] = [
  { prefix: 'claude-fable-5-1', price: price(10, 50, 0.25) },
  { prefix: 'claude-mythos-5-1', price: price(10, 50, 0.25) },
  { prefix: 'claude-fable-5', price: price(10, 50, 1) },
  { prefix: 'claude-mythos-5', price: price(10, 50, 1) },
  { prefix: 'claude-opus-5-5', price: price(4, 20, 0.2) },
  { prefix: 'claude-opus-5', price: price(5, 25, 0.5) },
  { prefix: 'claude-opus-4-8', price: price(5, 25, 0.5) },
  { prefix: 'claude-opus-4-7', price: price(5, 25, 0.5) },
  { prefix: 'claude-opus-4-6', price: price(5, 25, 0.5) },
  { prefix: 'claude-opus-4-5', price: price(5, 25, 0.5) },
  { prefix: 'claude-sonnet-5-5', price: price(2, 10, 0.2) },
  { prefix: 'claude-sonnet-5', price: price(2, 10, 0.2) },
  { prefix: 'claude-sonnet-4-6', price: price(3, 15, 0.3) },
  { prefix: 'claude-sonnet-4-5', price: price(3, 15, 0.3) },
  { prefix: 'claude-haiku-4-5', price: price(1, 5, 0.1) },
]

/**
 * Older models Claude Code transcripts may still name, deliberately without a price: the pricing source above lists
 * them (as legacy, deprecated or retired) but gives no price for them, and a guessed price would be a wrong
 * estimate. Their tokens are still counted. Add one to MODEL_PRICES only with a price from the source.
 */
export const UNPRICED_LEGACY_MODELS: readonly string[] = [
  'claude-sonnet-4',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-3-7-sonnet',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-opus',
  'claude-3-haiku',
]

const BY_LENGTH = [...MODEL_PRICES].sort((a, b) => b.prefix.length - a.prefix.length)

/**
 * The price of a model id such as `claude-opus-5-5` or `claude-sonnet-4-5-20250929`, or null when it is unknown.
 * A prefix matches the whole id or up to a separator (`-`, `@`, `[`, `:`), so `claude-opus-5` never matches a
 * hypothetical `claude-opus-50`, and the longest prefix wins (`claude-fable-5-1` over `claude-fable-5`).
 */
export function priceForModel(model: string): ModelPrice | null {
  const id = model.trim().toLowerCase()
  for (const { prefix, price } of BY_LENGTH) {
    if (!id.startsWith(prefix)) continue
    const next = id.charAt(prefix.length)
    if (next === '' || next === '-' || next === '@' || next === '[' || next === ':') return price
  }
  return null
}

/** One message's token counts, cache writes split by lifetime. */
export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export const totalTokens = (t: TokenCounts): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

/** Estimated USD cost of one message at API prices, or null when the model has no known price. */
export function messageCost(model: string, tokens: TokenCounts, fast = false): number | null {
  const p = priceForModel(model)
  if (!p) return null
  const perMillion =
    tokens.input * p.input +
    tokens.output * p.output +
    tokens.cacheRead * p.cacheRead +
    tokens.cacheWrite5m * p.input * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * p.input * CACHE_WRITE_1H_MULTIPLIER
  return (perMillion / 1_000_000) * (fast ? FAST_MODE_MULTIPLIER : 1)
}
