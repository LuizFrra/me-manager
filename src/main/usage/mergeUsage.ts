import type {
  ClaudeProfile,
  ProfileBilling,
  UsageBucket,
  UsageModelTotals,
  UsagePeriod,
  UsageSummary,
  UsageTotals,
} from '../../shared/types'
import { USAGE_PERIODS } from '../../shared/types'
import { emptyUsageBucket, emptyUsageSummary, usageTokens } from '../../shared/usage'
import type { ProfileUsageSummaries, UsageSummaries } from '../contracts'

/** A total as billed to a company: no cost, its priced tokens in companyTokens instead. */
function companyTotals<T extends UsageTotals>(t: T): T {
  return { ...t, cost: 0, companyTokens: usageTokens(t) - t.unpricedTokens }
}

const mapSummary = (s: UsageSummary, f: (b: UsageBucket, period: UsagePeriod) => UsageBucket): UsageSummary =>
  Object.fromEntries(USAGE_PERIODS.map((p) => [p, f(s[p], p)])) as Record<UsagePeriod, UsageBucket>

const mapValues = <T, U>(o: Record<string, T>, f: (v: T) => U): Record<string, U> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]))

/** One folder's usage as billed: as it was read for `own`, with its cost moved to companyTokens for `company`. */
export function billedUsage(usage: UsageSummaries, billing: ProfileBilling): UsageSummaries {
  if (billing === 'own') return usage
  const bill = (s: UsageSummary): UsageSummary =>
    mapSummary(s, (b) => ({ ...companyTotals(b), models: b.models.map(companyTotals) }))
  return { roots: mapValues(usage.roots, bill), groups: mapValues(usage.groups, bill) }
}

/** Adds `t` into `into`. Sessions add up: each folder has its own (a session is one folder's transcript). */
function addTotals(into: UsageTotals, t: UsageTotals): void {
  into.input += t.input
  into.output += t.output
  into.cacheRead += t.cacheRead
  into.cacheWrite5m += t.cacheWrite5m
  into.cacheWrite1h += t.cacheWrite1h
  into.cost += t.cost
  into.unpricedTokens += t.unpricedTokens
  into.companyTokens += t.companyTokens
  into.messages += t.messages
  into.sessions += t.sessions
  if (t.firstSeen !== null && (into.firstSeen === null || t.firstSeen < into.firstSeen)) into.firstSeen = t.firstSeen
  if (t.lastSeen !== null && (into.lastSeen === null || t.lastSeen > into.lastSeen)) into.lastSeen = t.lastSeen
}

/** Buckets of different folders added up, models by name, in the usage service's order. */
function addBuckets(buckets: readonly UsageBucket[]): UsageBucket {
  const out = emptyUsageBucket()
  const models = new Map<string, UsageModelTotals>()
  for (const b of buckets) {
    addTotals(out, b)
    for (const m of b.models) {
      const prev = models.get(m.model)
      if (prev) addTotals(prev, m)
      else models.set(m.model, { ...m })
    }
  }
  out.models = [...models.values()]
  for (const m of out.models) m.priced = m.unpricedTokens === 0
  out.models.sort((a, b) => b.cost - a.cost || usageTokens(b) - usageTokens(a) || a.model.localeCompare(b.model))
  return out
}

/** Several folders' usage added up; a root or group one of them lacks counts as empty there. */
function addUsage(list: readonly UsageSummaries[]): UsageSummaries {
  const empty = emptyUsageSummary()
  const add = (pick: (u: UsageSummaries) => Record<string, UsageSummary>): Record<string, UsageSummary> => {
    const keys = new Set(list.flatMap((u) => Object.keys(pick(u))))
    return Object.fromEntries(
      [...keys].map((k) => {
        const summaries = list.map((u) => pick(u)[k] ?? empty)
        return [k, mapSummary(empty, (_, p) => addBuckets(summaries.map((s) => s[p])))]
      }),
    )
  }
  return { roots: add((u) => u.roots), groups: add((u) => u.groups) }
}

/**
 * Every profile's usage, as billed, alone and together. Together, each folder counts once (profiles on one folder
 * share its reading), billed `own` when any of its profiles is: its cost then counts, as for budgets.
 */
export function mergeProfileUsage(entries: readonly ProfileUsageSummaries[]): {
  usage: UsageSummaries
  profiles: { profile: ClaudeProfile; usage: UsageSummaries }[]
} {
  const folders = new Map<string, { usage: UsageSummaries; billing: ProfileBilling }>()
  for (const { profile, folder, usage } of entries) {
    const known = folders.get(folder)
    if (!known) folders.set(folder, { usage, billing: profile.billing })
    else if (profile.billing === 'own') known.billing = 'own'
  }
  const billed = [...folders.values()].map((f) => billedUsage(f.usage, f.billing))
  return {
    // One folder (the usual case): its reading as it is, so nothing is copied.
    usage: billed.length === 1 ? billed[0] : addUsage(billed),
    profiles: entries.map(({ profile, usage }) => ({ profile, usage: billedUsage(usage, profile.billing) })),
  }
}
