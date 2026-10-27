import { appendFile, mkdir, open, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupTempDirs, makeTempDir } from '../files/testRepos'

// Wraps the real stat so tests can see how many run at once.
const statFlight = vi.hoisted(() => ({ now: 0, peak: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (async (...args: Parameters<typeof real.stat>) => {
    statFlight.peak = Math.max(statFlight.peak, ++statFlight.now)
    try {
      return await real.stat(...args)
    } finally {
      statFlight.now--
    }
  }) as typeof real.stat
  return { ...real, stat, default: { ...real, stat } }
})

import {
  claudeConfigDir,
  STAT_CONCURRENCY,
  encodeProjectPath,
  parseUsageLine,
  projectDirMatches,
  streamLines,
  UsageService,
} from './usageService'

interface Msg {
  id?: string
  req?: string
  cwd?: string
  model?: string
  ts?: string
  session?: string
  input?: number
  output?: number
  cacheRead?: number
  /** cache_creation_input_tokens; without eph5/eph1 there is no cache_creation split. */
  cacheWrite?: number
  eph5?: number
  eph1?: number
  speed?: string
  type?: string
}

let seq = 0
const NOW = new Date(2026, 9, 18, 15, 0, 0) // local time: Sunday 18 October 2026, 15:00
const TODAY = new Date(2026, 9, 18, 9, 0, 0).toISOString()

function line(m: Msg = {}): string {
  const n = ++seq
  const usage: Record<string, unknown> = {
    input_tokens: m.input ?? 0,
    output_tokens: m.output ?? 0,
    cache_read_input_tokens: m.cacheRead ?? 0,
    cache_creation_input_tokens: m.cacheWrite ?? 0,
    service_tier: 'standard',
  }
  if (m.eph5 !== undefined || m.eph1 !== undefined)
    usage.cache_creation = { ephemeral_5m_input_tokens: m.eph5 ?? 0, ephemeral_1h_input_tokens: m.eph1 ?? 0 }
  if (m.speed) usage.speed = m.speed
  return (
    JSON.stringify({
      type: m.type ?? 'assistant',
      timestamp: m.ts ?? TODAY,
      cwd: m.cwd ?? '/p/proj',
      sessionId: m.session ?? 's1',
      requestId: m.req ?? `req_${n}`,
      isSidechain: false,
      message: { id: m.id ?? `msg_${n}`, model: m.model ?? 'claude-opus-5-5', usage, content: [] },
    }) + '\n'
  )
}

let claudeDir: string
let projects: string

beforeEach(async () => {
  claudeDir = await makeTempDir('mm-usage-')
  projects = join(claudeDir, 'projects')
})
afterEach(cleanupTempDirs)

/** Writes a transcript under projects/<encoded cwd>/<rel>. */
async function put(projectPath: string, rel: string, content: string): Promise<string> {
  const file = join(projects, encodeProjectPath(projectPath), rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

const service = (now = NOW): UsageService => new UsageService({ claudeDir, now: () => now, minRefreshMs: 0 })

async function usageOf(svc: UsageService, root: string, roots: string[] = [root]): Promise<UsageServiceAll> {
  const result = await svc.summarize(roots)
  return result.roots[root]
}
type UsageServiceAll = Awaited<ReturnType<UsageService['summarize']>>['roots'][string]

describe('paths', () => {
  it('encodes every non-alphanumeric character as a dash', () => {
    expect(encodeProjectPath('/home/luiz/Desktop/projetos/me-manager')).toBe('-home-luiz-Desktop-projetos-me-manager')
    expect(encodeProjectPath('/home/u/.me-manager/worktrees/my_theme/r/t')).toBe(
      '-home-u--me-manager-worktrees-my-theme-r-t',
    )
  })

  it('matches a root’s folder and its subfolders’ folders, and long names by their first 200 characters', () => {
    expect(projectDirMatches('-p-proj', '-p-proj')).toBe(true)
    expect(projectDirMatches('-p-proj-src', '-p-proj')).toBe(true)
    expect(projectDirMatches('-p-project', '-p-proj')).toBe(false)
    const long = `-${'a'.repeat(250)}`
    expect(projectDirMatches(`${long.slice(0, 200)}-1a2b3c`, long)).toBe(true)
  })

  it('reads CLAUDE_CONFIG_DIR instead of ~/.claude when set', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/claude' })).toBe('/custom/claude')
    expect(claudeConfigDir({})).toMatch(/\.claude$/)
  })
})

describe('parseUsageLine', () => {
  it('skips malformed lines, other entry types, missing usage, a missing cwd and synthetic messages', () => {
    expect(parseUsageLine('not json "usage" "assistant"')).toBeNull()
    expect(parseUsageLine(line().slice(0, 60))).toBeNull()
    expect(parseUsageLine(line({ type: 'user' }))).toBeNull()
    expect(parseUsageLine(JSON.stringify({ type: 'assistant', cwd: '/p', message: { usage: null } }))).toBeNull()
    expect(parseUsageLine(line({ model: '<synthetic>' }))).toBeNull()
    const noCwd = JSON.parse(line())
    delete noCwd.cwd
    expect(parseUsageLine(JSON.stringify(noCwd))).toBeNull()
  })

  it('splits cache writes by lifetime, treating writes without a split as 5-minute ones', () => {
    expect(parseUsageLine(line({ cacheWrite: 100 }))?.record).toMatchObject({ cacheWrite5m: 100, cacheWrite1h: 0 })
    expect(parseUsageLine(line({ cacheWrite: 100, eph5: 30, eph1: 70 }))?.record).toMatchObject({
      cacheWrite5m: 30,
      cacheWrite1h: 70,
    })
  })
})

describe('streamLines', () => {
  it('returns complete lines with their offsets, and the unterminated rest separately', async () => {
    const file = await put('/x', 'a.jsonl', 'one\ntwo\nthr')
    const lines: [string, number][] = []
    const result = await streamLines(file, 0, 11, (l, at) => lines.push([l, at]))
    expect(lines).toEqual([
      ['one', 0],
      ['two', 4],
    ])
    expect(result).toEqual({ offset: 8, tail: 'thr' })
  })

  it('joins lines that span several reads, multi-byte characters included', async () => {
    const big = 'é'.repeat(400_000) // 800 kB: crosses the 256 kB read size more than once
    const file = await put('/x', 'a.jsonl', `${big}\nshort\n`)
    const lines: string[] = []
    const result = await streamLines(file, 0, Buffer.byteLength(big) + 7, (l) => lines.push(l))
    expect(lines).toEqual([big, 'short'])
    expect(result.tail).toBeNull()
  })
})

describe('UsageService', () => {
  it('counts each message once, taking the fullest usage among its lines', async () => {
    await put(
      '/p/proj',
      's1.jsonl',
      line({ id: 'm1', req: 'r1', input: 10, output: 3 }) +
        line({ id: 'm1', req: 'r1', input: 10, output: 500 }) +
        line({ id: 'm1', req: 'r1', input: 10, output: 500 }) +
        line({ id: 'm2', req: 'r2', input: 5, output: 1 }),
    )
    const all = (await usageOf(service(), '/p/proj')).all
    expect(all.messages).toBe(2)
    expect(all.input).toBe(15)
    expect(all.output).toBe(501)
    expect(all.cost).toBeCloseTo((15 * 4 + 501 * 20) / 1e6)
    expect(all.models).toHaveLength(1)
    expect(all.models[0]).toMatchObject({ model: 'claude-opus-5-5', priced: true, messages: 2 })
  })

  it('counts a message repeated in another transcript (a resumed session) once', async () => {
    const msg = line({ id: 'm1', req: 'r1', output: 100 })
    await put('/p/proj', 's1.jsonl', msg)
    await put('/p/proj', 's2.jsonl', msg + line({ output: 1 }))
    expect((await usageOf(service(), '/p/proj')).all).toMatchObject({ messages: 2, output: 101 })
  })

  it('reads only the bytes appended since the last read', async () => {
    const first = line({ input: 7 })
    const file = await put('/p/proj', 's1.jsonl', first)
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(7)

    // Overwrite the first line in place (same length) and append: an incremental read never sees the change.
    const fh = await open(file, 'r+')
    await fh.write(Buffer.from('x'.repeat(first.length - 1)), 0, first.length - 1, 0)
    await fh.close()
    await appendFile(file, line({ id: 'm1', req: 'r1', input: 3, output: 1 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, input: 10 })

    // De-duplication survives incremental reads: the same message again adds nothing, a fuller copy updates it.
    await appendFile(file, line({ id: 'm1', req: 'r1', input: 3, output: 1 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, input: 10, output: 1 })
    await appendFile(file, line({ id: 'm1', req: 'r1', input: 3, output: 9 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, input: 10, output: 9 })
  })

  it('counts an unterminated last line once, also after it is finished', async () => {
    const full = line({ id: 'm1', req: 'r1', input: 4 })
    const file = await put('/p/proj', 's1.jsonl', line({ input: 1 }) + full.slice(0, -1))
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, input: 5 })
    await appendFile(file, '\n' + line({ input: 10 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 3, input: 15 })
  })

  it('parses a file again from the start when it shrank', async () => {
    const file = await put('/p/proj', 's1.jsonl', line({ input: 1 }) + line({ input: 2 }) + line({ input: 3 }))
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(6)
    await writeFile(file, line({ input: 40 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 1, input: 40 })
  })

  it('parses a file again from the start when it was replaced by another one', async () => {
    const file = await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(1)
    const other = join(claudeDir, 'replacement.jsonl')
    await writeFile(other, line({ input: 20 }) + line({ input: 30 }))
    await rename(other, file)
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, input: 50 })
  })

  it('forgets a deleted transcript', async () => {
    await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const doomed = await put('/p/proj', 's2.jsonl', line({ input: 2 }))
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(3)
    const { rm } = await import('node:fs/promises')
    await rm(doomed)
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(1)
  })

  it('includes subagent transcripts in nested folders', async () => {
    await put('/p/proj', 's1.jsonl', line({ input: 1, session: 's1' }))
    await put('/p/proj', 's1/subagents/agent-a1.jsonl', line({ input: 2, session: 's1' }))
    await put('/p/proj', 's1/subagents/agent-a2.jsonl', line({ input: 4, session: 's1' }))
    await put('/p/proj', 's2.jsonl', line({ input: 8, session: 's2' }))
    expect((await usageOf(service(), '/p/proj')).all).toMatchObject({ messages: 4, input: 15, sessions: 2 })
  })

  it('maps each message to the most specific root containing its cwd, never to a sibling with the same prefix', async () => {
    const folder = '/p/proj'
    const task = '/p/proj/.worktrees/fix-login'
    const sibling = '/p/proj-2'
    await put(folder, 's1.jsonl', line({ cwd: folder, input: 1 }) + line({ cwd: `${folder}/src/lib`, input: 2 }))
    await put(`${folder}/src`, 's2.jsonl', line({ cwd: `${folder}/src`, input: 4 }))
    await put(task, 's3.jsonl', line({ cwd: task, input: 100 }) + line({ cwd: `${task}/pkg`, input: 200 }))
    await put(sibling, 's4.jsonl', line({ cwd: sibling, input: 1000 }))
    // Not a requested root's folder, so it is never read (even though its line names one).
    await put('/elsewhere', 's5.jsonl', line({ cwd: folder, input: 10000 }))

    const result = await service().summarize([folder, task])
    expect(result.roots[folder].all.input).toBe(7)
    expect(result.roots[task].all.input).toBe(300)
    const withSibling = await service().summarize([folder, sibling])
    expect(withSibling.roots[folder].all.input).toBe(307)
    expect(withSibling.roots[sibling].all.input).toBe(1000)
  })

  it('sums groups of roots, counting distinct sessions and each message once', async () => {
    await put('/p/a', 's1.jsonl', line({ cwd: '/p/a', session: 's1', input: 1 }))
    await put('/p/b', 's2.jsonl', line({ cwd: '/p/b', session: 's2', input: 2 }))
    await put('/p/b', 's1.jsonl', line({ cwd: '/p/b', session: 's1', input: 4 }))
    const result = await service().summarize(['/p/a', '/p/b'], { all: ['/p/a', '/p/b'], onlyB: ['/p/b'] })
    expect(result.groups.all.all).toMatchObject({ input: 7, messages: 3, sessions: 2 })
    expect(result.groups.onlyB.all).toMatchObject({ input: 6, sessions: 2 })
    expect(result.roots['/p/a'].all.sessions).toBe(1)
  })

  it('counts the tokens of unknown models without a cost, and skips synthetic messages', async () => {
    await put(
      '/p/proj',
      's1.jsonl',
      line({ model: 'claude-future-9', input: 10, output: 5, cacheRead: 100 }) +
        line({ model: '<synthetic>', input: 999 }) +
        line({ model: 'claude-haiku-4-5-20251001', output: 1_000_000 }),
    )
    const all = (await usageOf(service(), '/p/proj')).all
    expect(all.messages).toBe(2)
    expect(all.unpricedTokens).toBe(115)
    expect(all.cost).toBeCloseTo(5)
    expect(all.models.map((m) => [m.model, m.priced])).toEqual([
      ['claude-haiku-4-5-20251001', true],
      ['claude-future-9', false],
    ])
  })

  it('doubles the cost of fast-mode messages', async () => {
    await put(
      '/p/proj',
      's1.jsonl',
      line({ output: 1_000_000, speed: 'fast' }) + line({ output: 1_000_000, speed: 'standard' }),
    )
    expect((await usageOf(service(), '/p/proj')).all.cost).toBeCloseTo(40 + 20)
  })

  it('prices cache writes by lifetime', async () => {
    await put(
      '/p/proj',
      's1.jsonl',
      line({ cacheWrite: 1_000_000, eph1: 1_000_000 }) + line({ cacheWrite: 1_000_000 }), // no split: 5 minutes
    )
    const all = (await usageOf(service(), '/p/proj')).all
    expect(all).toMatchObject({ cacheWrite1h: 1_000_000, cacheWrite5m: 1_000_000 })
    expect(all.cost).toBeCloseTo(4 * 2 + 4 * 1.25)
  })

  it('skips malformed lines and keeps going', async () => {
    await put(
      '/p/proj',
      's1.jsonl',
      'garbage\n{"type":"assistant","message":{"usage":\n\n' +
        JSON.stringify({ type: 'user', cwd: '/p/proj', message: { usage: { input_tokens: 5 } } }) +
        '\n' +
        line({ input: 3 }),
    )
    expect((await usageOf(service(), '/p/proj')).all).toMatchObject({ messages: 1, input: 3 })
  })

  it('buckets by local day, the last 7 days and the calendar month', async () => {
    const at = (month: number, day: number, hour = 12): string => new Date(2026, month, day, hour).toISOString()
    await put(
      '/p/proj',
      's1.jsonl',
      line({ ts: at(9, 18, 0), input: 1 }) + // today, just after midnight
        line({ ts: at(9, 17, 23), input: 2 }) + // yesterday
        line({ ts: at(9, 12, 0), input: 4 }) + // 6 days ago: still this week
        line({ ts: at(9, 11, 23), input: 8 }) + // 7 days ago: this month only
        line({ ts: at(8, 30, 23), input: 16 }), // last month
    )
    const usage = await usageOf(service(), '/p/proj')
    expect(usage.today.input).toBe(1)
    expect(usage.week.input).toBe(7)
    expect(usage.month.input).toBe(15)
    expect(usage.all.input).toBe(31)
    expect(usage.all.firstSeen).toBe(at(8, 30, 23))
    expect(usage.all.lastSeen).toBe(at(9, 18, 0))
    expect(usage.today.models[0].input).toBe(1)

    // The same cached data, a day later.
    const tomorrow = await usageOf(service(new Date(2026, 9, 19, 8)), '/p/proj')
    expect(tomorrow.today.input).toBe(0)
    expect(tomorrow.week.input).toBe(3)
  })

  it('keeps a week that starts last month apart from the month, in roots, groups and models alike', async () => {
    const at = (month: number, day: number, hour = 12): string => new Date(2026, month, day, hour).toISOString()
    await put(
      '/p/a',
      's1.jsonl',
      line({ cwd: '/p/a', session: 'a1', ts: at(9, 3), input: 1 }) + // today
        line({ cwd: '/p/a', session: 'a2', ts: at(9, 1), input: 2, model: 'claude-sonnet-5' }) + // week and month
        line({ cwd: '/p/a', session: 'a3', ts: at(8, 28), input: 4 }) + // this week, last month
        line({ cwd: '/p/a', session: 'a3', ts: at(8, 20), input: 8 }), // neither
    )
    await put(
      '/p/b',
      's2.jsonl',
      line({ cwd: '/p/b', session: 'b1', ts: at(8, 29), input: 16, model: 'claude-sonnet-5' }),
    )
    const result = await service(new Date(2026, 9, 3, 15)).summarize(['/p/a', '/p/b'], { both: ['/p/a', '/p/b'] })
    const a = result.roots['/p/a']
    expect([a.today.input, a.week.input, a.month.input, a.all.input]).toEqual([1, 7, 3, 15])
    expect([a.today.sessions, a.week.sessions, a.month.sessions, a.all.sessions]).toEqual([1, 3, 2, 3])
    expect(a.week.firstSeen).toBe(at(8, 28))
    expect(a.month.firstSeen).toBe(at(9, 1))
    const both = result.groups.both
    expect([both.today.input, both.week.input, both.month.input, both.all.input]).toEqual([1, 23, 3, 31])
    expect(both.week.models.map((m) => [m.model, m.input, m.sessions])).toEqual([
      ['claude-sonnet-5', 18, 2],
      ['claude-opus-5-5', 5, 2],
    ])
    expect(both.all).toMatchObject({ messages: 5, sessions: 4, lastSeen: at(9, 3) })
  })

  it('returns empty usage when there are no transcripts at all', async () => {
    const usage = await usageOf(service(), '/p/none')
    expect(usage.all).toMatchObject({ messages: 0, cost: 0, firstSeen: null, models: [] })
  })

  it(`checks the transcripts ${STAT_CONCURRENCY} at a time, not one by one`, async () => {
    expect(STAT_CONCURRENCY).toBe(16)
    for (let i = 0; i < 40; i++) await put('/p/proj', `s${i}.jsonl`, line({ input: 1 }))
    statFlight.peak = 0
    const all = (await usageOf(service(), '/p/proj')).all
    expect(all.messages).toBe(40)
    expect(statFlight.peak).toBe(STAT_CONCURRENCY)
  })

  it('reuses the cached result while nothing changed', async () => {
    await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const svc = service()
    const a = await svc.summarize(['/p/proj'])
    const b = await svc.summarize(['/p/proj'])
    expect(b).toBe(a)
  })
})
