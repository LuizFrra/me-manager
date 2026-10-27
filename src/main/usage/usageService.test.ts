import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupTempDirs, makeTempDir } from '../files/testRepos'

// Wraps the real open so tests can see how many transcripts are read at once.
const openFlight = vi.hoisted(() => ({ now: 0, peak: 0, paths: [] as string[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const open = (async (...args: Parameters<typeof real.open>) => {
    openFlight.paths.push(String(args[0]))
    openFlight.peak = Math.max(openFlight.peak, ++openFlight.now)
    try {
      return await real.open(...args)
    } finally {
      openFlight.now--
    }
  }) as typeof real.open
  return { ...real, open, default: { ...real, open } }
})
// Wraps the real statSync and readdirSync so tests can see when each ran, as counted by `ticks` (see below).
const statLog = vi.hoisted(() => ({ ticks: 0, calls: [] as number[], dirs: [] as number[] }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    statLog.calls.push(statLog.ticks)
    return real.statSync(...args)
  }) as typeof real.statSync
  const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
    statLog.dirs.push(statLog.ticks)
    return real.readdirSync(...args)
  }) as typeof real.readdirSync
  return { ...real, statSync, readdirSync, default: { ...real, statSync, readdirSync } }
})

/** Counts turns of the event loop in statLog.ticks while `fn` runs. */
async function ticking<T>(fn: () => Promise<T>): Promise<T> {
  let on = true
  const tick = (): void => {
    statLog.ticks++
    if (on) setImmediate(tick)
  }
  setImmediate(tick)
  try {
    return await fn()
  } finally {
    on = false
  }
}

/** The largest number of calls in `log` made without a turn of the event loop in between. */
const largestRun = (log: number[]): number => {
  const runs = new Map<number, number>()
  for (const t of log) runs.set(t, (runs.get(t) ?? 0) + 1)
  return Math.max(0, ...runs.values())
}

import {
  claudeConfigDir,
  encodeProjectPath,
  mergeRecords,
  parseUsageLine,
  projectDirMatches,
  DIR_SLICE,
  READ_CONCURRENCY,
  STAT_SLICE,
  streamLines,
  USAGE_CACHE_VERSION,
  UsageService,
  type UsageRecord,
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

  it('names the folder it reads the transcripts from', () => {
    expect(new UsageService({ claudeDir: '/custom/claude' }).projectsDir).toBe(join('/custom/claude', 'projects'))
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

  it('passes on only the lines containing the filter, short or spanning several reads', async () => {
    const big = (word: string): string => `${'é'.repeat(200_000)}${word}${'é'.repeat(200_000)}`
    const content = ['a "usage" b', 'nothing', big('"usage"'), big('"usag'), 'last "usage"', 'x'].join('\n') + '\n'
    const file = await put('/x', 'a.jsonl', content + 'tail without')
    const lines: [string, number][] = []
    const filter = Buffer.from('"usage"')
    const result = await streamLines(file, 0, Buffer.byteLength(content) + 12, (l, at) => lines.push([l, at]), filter)
    const at = (l: string): number => Buffer.byteLength(content.slice(0, content.indexOf(l)))
    expect(lines).toEqual([
      ['a "usage" b', 0],
      [big('"usage"'), at(big('"usage"'))],
      ['last "usage"', at('last "usage"')],
    ])
    // The tail is returned as it is: it may still be growing into a matching line.
    expect(result).toEqual({ offset: Buffer.byteLength(content), tail: 'tail without' })
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

  it('keeps a message shared by two transcripts once as either grows, and after either goes', async () => {
    const a = await put('/p/proj', 's1.jsonl', line({ id: 'm1', req: 'r1', output: 5 }))
    const b = await put('/p/proj', 's2.jsonl', line({ input: 1 }))
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, output: 5, input: 1 })
    // The other transcript gets a fuller copy, then the first a stale one: the fullest counts, once.
    await appendFile(b, line({ id: 'm1', req: 'r1', output: 50, input: 2 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, output: 50, input: 3 })
    await appendFile(a, line({ id: 'm1', req: 'r1', output: 7 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 2, output: 50, input: 3 })
    // Without the fuller copy, the first transcript's own lines count again.
    const { rm } = await import('node:fs/promises')
    await rm(b)
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 1, output: 7, input: 0 })
    // A copy rewritten smaller is read from the start, so its old numbers go too.
    await writeFile(a, line({ id: 'm1', req: 'r1', output: 6 }))
    expect((await usageOf(svc, '/p/proj')).all).toMatchObject({ messages: 1, output: 6 })
  })

  it('merges the copies of a message the same way whatever order they are read in', () => {
    const rec = (m: Msg, at: number | null = null): UsageRecord => {
      const r = parseUsageLine(line({ id: 'm1', req: 'r1', ...m }))!.record
      if (at !== null) r.ts = at
      return r
    }
    const copies = [
      rec({ cwd: '/p/b', session: 'b', output: 5 }),
      rec({ cwd: '/p/a', session: 'a', output: 5 }), // the same time: the first path wins
      rec({ cwd: '/p/c', session: 'c', output: 2, speed: 'fast' }, NaN), // no time: never the one that counts
      rec({ cwd: '/p/d', session: 'd', input: 1 }, Date.parse(TODAY) + 1000),
    ]
    const results = [
      copies.reduce(mergeRecords),
      [...copies].reverse().reduce(mergeRecords),
      [copies[2], copies[0], copies[3], copies[1]].reduce(mergeRecords),
    ]
    for (const r of results) {
      expect(r).toEqual(results[0])
      expect(r).toMatchObject({ cwd: '/p/a', session: 'a', ts: Date.parse(TODAY), output: 5, input: 1, fast: true })
    }
  })

  it('counts a message copied into two tasks’ transcripts for the same task whichever is read first', async () => {
    const msg = { id: 'm1', req: 'r1', output: 5 }
    await put('/p/a', 's1.jsonl', line({ ...msg, cwd: '/p/a', session: 'sa' }))
    await put('/p/b', 's2.jsonl', line({ ...msg, cwd: '/p/b', session: 'sb' }) + line({ cwd: '/p/b', input: 1 }))
    const extra = await put('/p/b', 's3.jsonl', line({ cwd: '/p/b', input: 2 }))
    const both = ['/p/a', '/p/b']
    const aFirst = service()
    await aFirst.summarize(['/p/a'])
    const bFirst = service()
    await bFirst.summarize(['/p/b'])
    const expected = await service().summarize(both)
    expect(expected.roots['/p/a'].all).toMatchObject({ messages: 1, output: 5, sessions: 1 })
    expect(await aFirst.summarize(both)).toEqual(expected)
    expect(await bFirst.summarize(both)).toEqual(expected)

    // A transcript deleted: the merged messages are summed again from the files, and nothing moves.
    const { rm } = await import('node:fs/promises')
    await rm(extra)
    const rebuilt = await service().summarize(both)
    expect(rebuilt.roots['/p/a'].all).toMatchObject({ messages: 1, output: 5 })
    expect(await aFirst.summarize(both)).toEqual(rebuilt)
    expect(await bFirst.summarize(both)).toEqual(rebuilt)
  })

  it('keeps counting a transcript replaced by one it cannot read yet, until it can', async () => {
    const file = await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const svc = service()
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(1)
    const other = join(claudeDir, 'replacement.jsonl')
    await writeFile(other, line({ input: 20 }))
    await chmod(other, 0)
    await rename(other, file)
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(1)
    await chmod(file, 0o644)
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(20)
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

  it('moves usage out of today, this week and this month as the clock passes midnight, with no transcript changed', async () => {
    const at = (month: number, day: number, hour = 12): string => new Date(2026, month, day, hour).toISOString()
    await put(
      '/p/proj',
      's1.jsonl',
      line({ ts: at(9, 31, 23), input: 1 }) + line({ ts: at(9, 25, 1), input: 2 }) + line({ ts: at(9, 1), input: 4 }),
    )
    let now = new Date(2026, 9, 31, 23, 59)
    const svc = new UsageService({ claudeDir, now: () => now, minRefreshMs: 0 })
    const periods = async (): Promise<number[]> => {
      const u = await usageOf(svc, '/p/proj')
      return [u.today.input, u.week.input, u.month.input, u.all.input]
    }
    expect(await periods()).toEqual([1, 3, 7, 7])
    now = new Date(2026, 10, 1, 0, 1) // a new day, week and month
    expect(await periods()).toEqual([0, 1, 0, 7])
  })

  it('sums each change into the same totals as reading everything afresh', async () => {
    const at = (day: number, hour = 12): string => new Date(2026, 9, day, hour).toISOString()
    const roots = ['/p/a', '/p/a/wt', '/p/b']
    const groups = { total: roots, t1: ['/p/a', '/p/a/wt'], t2: ['/p/b'] }
    const a = await put('/p/a', 's1.jsonl', line({ cwd: '/p/a', ts: at(18), input: 1, session: 'a' }))
    const wt = await put('/p/a/wt', 's2.jsonl', line({ cwd: '/p/a/wt', ts: at(12), output: 2, session: 'w' }))
    const b = await put('/p/b', 's3.jsonl', line({ cwd: '/p/b', ts: at(1), cacheRead: 4, model: 'claude-sonnet-5' }))
    const svc = service()
    const same = async (): Promise<void> => {
      expect(await svc.summarize(roots, groups)).toEqual(await service().summarize(roots, groups))
    }
    await same()
    await appendFile(wt, line({ id: 'm1', req: 'r1', cwd: '/p/a/wt/pkg', output: 8, session: 'w2' }))
    await same()
    await appendFile(b, line({ id: 'm1', req: 'r1', cwd: '/p/a/wt/pkg', output: 16, session: 'w2' })) // fuller copy
    await same()
    await appendFile(a, line({ cwd: '/p/a', ts: at(17), input: 32, model: 'claude-future-9' }))
    await same()
    const { rm } = await import('node:fs/promises')
    await rm(b)
    await same()
    expect((await svc.summarize(roots, groups)).groups.t1.all).toMatchObject({ input: 33, output: 10, messages: 4 })
  })

  it('returns empty usage when there are no transcripts at all', async () => {
    const usage = await usageOf(service(), '/p/none')
    expect(usage.all).toMatchObject({ messages: 0, cost: 0, firstSeen: null, models: [] })
  })

  it(`reads changed transcripts ${READ_CONCURRENCY} at a time, not one by one`, async () => {
    expect(READ_CONCURRENCY).toBe(16)
    for (let i = 0; i < 40; i++) await put('/p/proj', `s${i}.jsonl`, line({ input: 1 }))
    openFlight.peak = 0
    const all = (await usageOf(service(), '/p/proj')).all
    expect(all.messages).toBe(40)
    expect(openFlight.peak).toBe(READ_CONCURRENCY)
  })

  it(`checks the transcripts at most ${STAT_SLICE} at a time between turns of the event loop`, async () => {
    const count = STAT_SLICE * 2 + 10
    for (let i = 0; i < count; i++) await put('/p/proj', `s${i}.jsonl`, line({ input: 1 }))
    const svc = service()
    await usageOf(svc, '/p/proj')
    statLog.calls = []
    expect((await ticking(() => usageOf(svc, '/p/proj'))).all.messages).toBe(count)
    expect(statLog.calls).toHaveLength(count)
    expect(largestRun(statLog.calls)).toBeLessThanOrEqual(STAT_SLICE)
    expect(new Set(statLog.calls).size).toBeGreaterThanOrEqual(3)
  })

  it(`lists the folders at most ${DIR_SLICE} at a time between turns of the event loop`, async () => {
    const count = DIR_SLICE + 5
    for (let i = 0; i < count; i++) await put('/p/proj', `s${i}/subagents/agent-a.jsonl`, line({ input: 1 }))
    const svc = service()
    await usageOf(svc, '/p/proj')
    statLog.dirs = []
    expect((await ticking(() => usageOf(svc, '/p/proj'))).all.messages).toBe(count)
    expect(statLog.dirs).toHaveLength(1 + count * 2) // the project folder, each session's and its subagents'
    expect(largestRun(statLog.dirs)).toBeLessThanOrEqual(DIR_SLICE)
  })

  it('reuses the cached result while nothing changed', async () => {
    await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const svc = service()
    const a = await svc.summarize(['/p/proj'])
    const b = await svc.summarize(['/p/proj'])
    expect(b).toBe(a)
  })
})

describe('UsageService cache', () => {
  let cacheFile: string
  beforeEach(() => {
    cacheFile = join(claudeDir, 'app-home', 'usage-cache.json')
  })
  /** A service that keeps its cache in cacheFile, written only when a test asks (saveCache). */
  const cached = (now = NOW): UsageService =>
    new UsageService({ claudeDir, now: () => now, minRefreshMs: 0, cacheFile, cacheSaveDelayMs: 3_600_000 })
  /** The transcripts a call to `fn` opened. */
  async function opened(fn: () => Promise<unknown>): Promise<string[]> {
    openFlight.paths = []
    await fn()
    return openFlight.paths.filter((p) => p.endsWith('.jsonl'))
  }

  it('reads no unchanged transcript again after a restart, with the same result', async () => {
    const at = (day: number): string => new Date(2026, 9, day, 12).toISOString()
    await put('/p/a', 's1.jsonl', line({ cwd: '/p/a', ts: at(18), input: 1, model: 'claude-future-9' }))
    await put('/p/a', 's1/subagents/agent-x.jsonl', line({ cwd: '/p/a/sub', ts: at(2), output: 2, speed: 'fast' }))
    await put('/p/b', 's2.jsonl', line({ cwd: '/p/b', ts: 'nonsense', cacheWrite: 30, eph1: 30 }))
    const groups = { both: ['/p/a', '/p/b'] }
    const first = cached()
    const before = await first.summarize(['/p/a', '/p/b'], groups)
    await first.saveCache()

    const restarted = cached()
    let after: unknown
    expect(await opened(async () => (after = await restarted.summarize(['/p/a', '/p/b'], groups)))).toEqual([])
    expect(after).toEqual(before)
  })

  it('reads a transcript that grew since from where the cache left it', async () => {
    const first = line({ input: 7 })
    const file = await put('/p/proj', 's1.jsonl', first)
    const svc = cached()
    await usageOf(svc, '/p/proj')
    await svc.saveCache()

    // Overwrite the first line in place and append: only a read resumed at the cached offset still counts it.
    const fh = await open(file, 'r+')
    await fh.write(Buffer.from('x'.repeat(first.length - 1)), 0, first.length - 1, 0)
    await fh.close()
    await appendFile(file, line({ input: 3 }))
    expect((await usageOf(cached(), '/p/proj')).all).toMatchObject({ messages: 2, input: 10 })
  })

  it('reads a transcript again from the start when it was replaced, shrank or was deleted since', async () => {
    const replaced = await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const shrunk = await put('/p/proj', 's2.jsonl', line({ input: 2 }) + line({ input: 4 }))
    const deleted = await put('/p/proj', 's3.jsonl', line({ input: 8 }))
    const svc = cached()
    expect((await usageOf(svc, '/p/proj')).all.input).toBe(15)
    await svc.saveCache()

    const other = join(claudeDir, 'replacement.jsonl')
    await writeFile(other, line({ input: 16 }))
    await rename(other, replaced)
    await writeFile(shrunk, line({ input: 32 }))
    await rm(deleted)
    expect((await usageOf(cached(), '/p/proj')).all).toMatchObject({ messages: 2, input: 48 })
  })

  it('ignores a corrupt cache, or one from another version or folder, and writes a good one', async () => {
    await put('/p/proj', 's1.jsonl', line({ input: 5 }))
    const svc = cached()
    await usageOf(svc, '/p/proj')
    await svc.saveCache()
    const good = JSON.parse(await readFile(cacheFile, 'utf8'))
    expect(good.v).toBe(USAGE_CACHE_VERSION)

    const entry = Object.values(good.files)[0] as { r: unknown[] }
    const bad = [
      '{"v":',
      JSON.stringify({ ...good, v: USAGE_CACHE_VERSION + 1 }),
      JSON.stringify({ ...good, dir: '/elsewhere' }),
      JSON.stringify({ ...good, files: { x: { ...entry, r: ['k', -1] } } }),
      JSON.stringify({
        ...good,
        files: Object.fromEntries(Object.keys(good.files).map((k) => [k, { ...entry, r: [1] }])),
      }),
    ]
    for (const content of bad) {
      await writeFile(cacheFile, content)
      const fresh = cached()
      expect(await opened(() => usageOf(fresh, '/p/proj'))).toHaveLength(1)
      expect((await usageOf(fresh, '/p/proj')).all).toMatchObject({ messages: 1, input: 5 })
      await fresh.saveCache()
      expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual(good)
    }
  })

  it('keeps the cached transcripts of folders a call did not ask about', async () => {
    await put('/p/a', 's1.jsonl', line({ cwd: '/p/a', input: 1 }))
    await put('/p/b', 's2.jsonl', line({ cwd: '/p/b', input: 2 }))
    const svc = cached()
    await svc.summarize(['/p/a', '/p/b'])
    await svc.saveCache()

    const onlyA = cached()
    await usageOf(onlyA, '/p/a')
    await appendFile(join(projects, encodeProjectPath('/p/a'), 's1.jsonl'), line({ cwd: '/p/a', input: 4 }))
    await usageOf(onlyA, '/p/a')
    await onlyA.saveCache()

    const both = cached()
    let result: Awaited<ReturnType<UsageService['summarize']>> | undefined
    const reads = await opened(async () => (result = await both.summarize(['/p/a', '/p/b'])))
    expect(reads).toEqual([]) // /p/a's growth was saved too
    expect(result!.roots['/p/a'].all.input).toBe(5)
    expect(result!.roots['/p/b'].all.input).toBe(2)
  })

  it('writes the cache atomically, soon after a scan changed it and then at most once per interval', async () => {
    const file = await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const svc = new UsageService({
      claudeDir,
      now: () => NOW,
      minRefreshMs: 0,
      cacheFile,
      cacheSaveDelayMs: 10,
      cacheSaveIntervalMs: 3_600_000,
    })
    await usageOf(svc, '/p/proj')
    await vi.waitFor(async () => expect((await stat(cacheFile)).isFile()).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    const written = (await stat(cacheFile)).mtimeMs
    await appendFile(file, line({ input: 2 }))
    await usageOf(svc, '/p/proj')
    await new Promise((r) => setTimeout(r, 50))
    expect((await stat(cacheFile)).mtimeMs).toBe(written) // not again within the interval
    expect(await readdir(dirname(cacheFile))).toEqual(['usage-cache.json']) // no temp file left behind

    await svc.saveCache() // now
    const restarted = cached()
    expect(await opened(() => usageOf(restarted, '/p/proj'))).toEqual([])
    expect((await usageOf(restarted, '/p/proj')).all.input).toBe(3)
  })

  it('writes nothing while nothing changed, and nothing without a cache file', async () => {
    await put('/p/proj', 's1.jsonl', line({ input: 1 }))
    const svc = cached()
    await usageOf(svc, '/p/proj')
    await svc.saveCache()
    await rm(cacheFile)
    await usageOf(svc, '/p/proj')
    await svc.saveCache()
    await expect(stat(cacheFile)).rejects.toThrow()

    const plain = service()
    await usageOf(plain, '/p/proj')
    await plain.saveCache()
    expect(await readdir(dirname(cacheFile))).toEqual([])
  })
})
