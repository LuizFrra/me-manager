import { describe, expect, it } from 'vitest'
import type { ClaudeProfile, ProfileBilling, UsageModelTotals, UsageSummary } from '../../shared/types'
import { emptyUsageSummary } from '../../shared/usage'
import type { ProfileUsageSummaries, UsageSummaries } from '../contracts'
import { billedUsage, mergeProfileUsage } from './mergeUsage'

const profile = (id: string, billing: ProfileBilling, configDir = `/home/me/.claude-${id}`): ClaudeProfile => ({
  id,
  name: id,
  configDir,
  billing,
})

const model = (name: string, tokens: number, cost: number | null): UsageModelTotals => ({
  ...emptyUsageSummary().all,
  model: name,
  priced: cost !== null,
  input: tokens,
  cost: cost ?? 0,
  unpricedTokens: cost === null ? tokens : 0,
  messages: 1,
  sessions: 1,
})

/** A summary whose every period holds `models`, summed, with the given sessions and first and last message. */
function summary(models: UsageModelTotals[], first = '2026-10-01T00:00:00.000Z', last = first): UsageSummary {
  const s = emptyUsageSummary()
  for (const b of Object.values(s)) {
    for (const m of models) {
      b.input += m.input
      b.cost += m.cost
      b.unpricedTokens += m.unpricedTokens
      b.messages += m.messages
      b.sessions += m.sessions
    }
    b.firstSeen = models.length ? first : null
    b.lastSeen = models.length ? last : null
    b.models = models.map((m) => ({ ...m }))
  }
  return s
}

const usage = (root: UsageSummary, total = root): UsageSummaries => ({ roots: { '/p': root }, groups: { total } })

const entry = (p: ClaudeProfile, u: UsageSummaries, folder = p.configDir): ProfileUsageSummaries => ({
  profile: p,
  folder,
  usage: u,
})

describe('billedUsage', () => {
  it('leaves an own-billed folder as it is', () => {
    const u = usage(summary([model('claude-opus-5-5', 100, 2)]))
    expect(billedUsage(u, 'own')).toBe(u)
  })

  it('moves a company-billed folder’s priced tokens from cost to companyTokens, leaving unpriced ones as they are', () => {
    const u = usage(summary([model('claude-opus-5-5', 100, 2), model('claude-future-9', 7, null)]))
    const billed = billedUsage(u, 'company').roots['/p'].all
    expect(billed).toMatchObject({ input: 107, cost: 0, companyTokens: 100, unpricedTokens: 7, messages: 2 })
    expect(billed.models.map((m) => [m.model, m.cost, m.companyTokens, m.unpricedTokens, m.priced])).toEqual([
      ['claude-opus-5-5', 0, 100, 0, true],
      ['claude-future-9', 0, 0, 7, false],
    ])
    expect(u.roots['/p'].all.cost).toBe(2) // the folder's own reading is left alone
  })
})

describe('mergeProfileUsage', () => {
  it('returns a single own-billed folder’s usage as it is', () => {
    const u = usage(summary([model('claude-opus-5-5', 100, 2)]))
    const merged = mergeProfileUsage([entry(profile('default', 'own'), u)])
    expect(merged.usage).toBe(u)
    expect(merged.profiles).toEqual([{ profile: profile('default', 'own'), usage: u }])
  })

  it('adds up tokens of every profile, cost of own-billed ones only, and the rest as company tokens', () => {
    const own = profile('default', 'own')
    const work = profile('work', 'company')
    const merged = mergeProfileUsage([
      entry(
        own,
        usage(summary([model('claude-opus-5-5', 100, 2)], '2026-10-02T00:00:00.000Z', '2026-10-05T00:00:00.000Z')),
      ),
      entry(
        work,
        usage(
          summary(
            [model('claude-opus-5-5', 40, 0.5), model('claude-future-9', 3, null)],
            '2026-10-01T00:00:00.000Z',
            '2026-10-03T00:00:00.000Z',
          ),
        ),
      ),
    ])
    const all = merged.usage.roots['/p'].all
    expect(all).toMatchObject({
      input: 143,
      cost: 2,
      companyTokens: 40,
      unpricedTokens: 3,
      messages: 3,
      sessions: 3,
      firstSeen: '2026-10-01T00:00:00.000Z',
      lastSeen: '2026-10-05T00:00:00.000Z',
    })
    expect(all.models.map((m) => [m.model, m.input, m.cost, m.companyTokens, m.messages])).toEqual([
      ['claude-opus-5-5', 140, 2, 40, 2],
      ['claude-future-9', 3, 0, 0, 1],
    ])
    expect(merged.usage.groups.total.today.cost).toBe(2)
    // Each profile alone, as billed.
    expect(merged.profiles.map((p) => [p.profile.id, p.usage.roots['/p'].all.cost])).toEqual([
      ['default', 2],
      ['work', 0],
    ])
    expect(merged.profiles[1].usage.roots['/p'].all.companyTokens).toBe(40)
  })

  it('counts a folder shared by two profiles once, at its cost when either is own-billed', () => {
    const u = usage(summary([model('claude-opus-5-5', 100, 2)]))
    const own = profile('default', 'own', '/home/me/.claude')
    const alias = profile('alias', 'company', '/home/me/alias')
    const merged = mergeProfileUsage([entry(own, u, '/home/me/.claude'), entry(alias, u, '/home/me/.claude')])
    expect(merged.usage.roots['/p'].all).toMatchObject({ input: 100, cost: 2, companyTokens: 0 })
    expect(merged.profiles.map((p) => p.usage.roots['/p'].all.cost)).toEqual([2, 0])
  })

  it('keeps every root and group of either profile, empty where a profile has none', () => {
    const a = usage(summary([model('claude-opus-5-5', 1, 1)]))
    const b: UsageSummaries = { roots: { '/q': summary([model('claude-opus-5-5', 2, 1)]) }, groups: {} }
    const merged = mergeProfileUsage([entry(profile('default', 'own'), a), entry(profile('x', 'own'), b)])
    expect(Object.keys(merged.usage.roots).sort()).toEqual(['/p', '/q'])
    expect(merged.usage.roots['/q'].all.input).toBe(2)
    expect(merged.usage.groups.total.all.input).toBe(1)
  })
})
