import { describe, expect, it } from 'vitest'
import { MODEL_PRICES, messageCost, priceForModel, type TokenCounts } from './pricing'

const tokens = (over: Partial<TokenCounts> = {}): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...over,
})

const MTOK = 1_000_000

describe('priceForModel', () => {
  it('matches the longest prefix first', () => {
    expect(priceForModel('claude-fable-5-1')?.cacheRead).toBe(0.25)
    expect(priceForModel('claude-fable-5')?.cacheRead).toBe(1)
    expect(priceForModel('claude-mythos-5-1')?.cacheRead).toBe(0.25)
    expect(priceForModel('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2 })
    expect(priceForModel('claude-opus-5')).toEqual({ input: 5, output: 25, cacheRead: 0.5 })
  })

  it('accepts date and variant suffixes', () => {
    expect(priceForModel('claude-sonnet-4-5-20250929')).toEqual({ input: 3, output: 15, cacheRead: 0.3 })
    expect(priceForModel('claude-opus-4-6[1m]')?.input).toBe(5)
    expect(priceForModel('claude-haiku-4-5@20251001')?.input).toBe(1)
    expect(priceForModel('Claude-Opus-5-5')?.input).toBe(4)
  })

  it('knows nothing of other models, or of ids that only share the start of a number', () => {
    expect(priceForModel('claude-3-opus-20240229')).toBeNull()
    expect(priceForModel('gpt-5')).toBeNull()
    expect(priceForModel('claude-opus-50')).toBeNull()
    expect(priceForModel('')).toBeNull()
  })

  it('has a price for every listed prefix', () => {
    for (const { prefix, price } of MODEL_PRICES) expect(priceForModel(prefix)).toBe(price)
  })
})

describe('messageCost', () => {
  it('prices input, output and cache reads per million tokens', () => {
    expect(messageCost('claude-opus-5-5', tokens({ input: MTOK }))).toBeCloseTo(4)
    expect(messageCost('claude-opus-5-5', tokens({ output: MTOK }))).toBeCloseTo(20)
    expect(messageCost('claude-opus-5-5', tokens({ cacheRead: MTOK }))).toBeCloseTo(0.2)
    expect(messageCost('claude-sonnet-4-5', tokens({ input: 1000, output: 2000 }))).toBeCloseTo(0.003 + 0.03)
  })

  it('prices 5-minute cache writes at 1.25× input and 1-hour writes at 2× input', () => {
    expect(messageCost('claude-sonnet-4-6', tokens({ cacheWrite5m: MTOK }))).toBeCloseTo(3.75)
    expect(messageCost('claude-sonnet-4-6', tokens({ cacheWrite1h: MTOK }))).toBeCloseTo(6)
  })

  it('doubles the whole message in fast mode', () => {
    const t = tokens({ input: MTOK, output: MTOK, cacheRead: MTOK, cacheWrite1h: MTOK })
    const normal = messageCost('claude-haiku-4-5', t)!
    expect(normal).toBeCloseTo(1 + 5 + 0.1 + 2)
    expect(messageCost('claude-haiku-4-5', t, true)).toBeCloseTo(normal * 2)
  })

  it('is null for an unknown model, and 0 for no tokens', () => {
    expect(messageCost('claude-future-9', tokens({ input: 10 }))).toBeNull()
    expect(messageCost('claude-opus-5-5', tokens())).toBe(0)
  })
})
