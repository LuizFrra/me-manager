import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { messageCost, totalTokens, type TokenCounts } from '../../shared/pricing'
import type { UsageBucket, UsageModelTotals, UsagePeriod, UsageSummary, UsageTotals } from '../../shared/types'
import { USAGE_PERIODS } from '../../shared/types'
import { mapLimit } from '../concurrency'
import type { UsageApi, UsageSummaries } from '../contracts'

/** Lines longer than this are skipped unparsed (never held in memory whole). */
export const MAX_LINE_BYTES = 32 * 1024 * 1024
/** Read size when streaming a transcript. */
const CHUNK_BYTES = 256 * 1024
/** At most this many transcript files are tracked; the rest are ignored (and logged once). */
export const MAX_TRACKED_FILES = 20_000
/** How deep to look for transcripts inside a project folder (`<session>/subagents/*.jsonl` is depth 2). */
const MAX_SCAN_DEPTH = 4
/** Calls closer together than this reuse the last scan instead of stat-ing every transcript again. */
const DEFAULT_MIN_REFRESH_MS = 1_000
/** Transcripts stat-ed (and, when changed, read) at the same time by a scan. */
export const STAT_CONCURRENCY = 16
/** Claude Code shortens project folder names longer than this and appends a hash. */
const MAX_ENCODED_LENGTH = 200

/** The Claude config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** The folder name Claude Code keeps a working directory's transcripts in: every non-alphanumeric becomes '-'. */
export const encodeProjectPath = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * Whether a project folder may hold transcripts of `encodedRoot` or a folder inside it. The encoding is lossy
 * (`/a/b-c` and `/a/b/c` both give `-a-b-c`), so this over-matches; each line's own `cwd` decides in the end.
 */
export function projectDirMatches(dirName: string, encodedRoot: string): boolean {
  if (encodedRoot.length > MAX_ENCODED_LENGTH) return dirName.startsWith(encodedRoot.slice(0, MAX_ENCODED_LENGTH))
  return dirName === encodedRoot || dirName.startsWith(`${encodedRoot}-`)
}

/** One assistant message's usage, as kept in memory. */
export interface UsageRecord extends TokenCounts {
  /** Epoch ms of the message; NaN when the line had no valid timestamp (it then only counts for all time). */
  ts: number
  cwd: string
  session: string
  model: string
  fast: boolean
  /** Estimated cost at API prices; null for an unpriced model. */
  cost: number | null
}

export interface ParsedUsageLine {
  /** `message.id` + `requestId` (the same message is written on several lines); null when the line has neither. */
  key: string | null
  record: UsageRecord
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The usage on one transcript line, or null when the line doesn't count: not an assistant message with
 * `message.usage`, a `<synthetic>` model, no `cwd`, or not valid JSON.
 */
export function parseUsageLine(line: string, fallbackSession = ''): ParsedUsageLine | null {
  // Cheap filter first: most lines (user turns, tool results) are never parsed.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let d: unknown
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object') return null
  const entry = d as Record<string, unknown>
  if (entry.type !== 'assistant') return null
  const message = entry.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!message || !usage || typeof usage !== 'object') return null
  const model = str(message.model) ?? 'unknown'
  if (model === '<synthetic>') return null
  const cwd = str(entry.cwd)
  if (!cwd) return null

  const creation = usage.cache_creation as Record<string, unknown> | undefined
  const written = count(usage.cache_creation_input_tokens)
  let cacheWrite5m: number
  let cacheWrite1h: number
  if (creation && typeof creation === 'object') {
    cacheWrite1h = count(creation.ephemeral_1h_input_tokens)
    cacheWrite5m = count(creation.ephemeral_5m_input_tokens)
    // Writes the split doesn't account for are priced as 5-minute ones.
    cacheWrite5m += Math.max(0, written - cacheWrite5m - cacheWrite1h)
  } else {
    cacheWrite5m = written
    cacheWrite1h = 0
  }
  const tokens: TokenCounts = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
  }
  const fast = usage.speed === 'fast'
  const id = str(message.id)
  const requestId = str(entry.requestId)
  const key = id || requestId ? `${id ?? ''}\u0000${requestId ?? ''}` : null
  const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return {
    key,
    record: {
      ...tokens,
      ts,
      cwd,
      session: str(entry.sessionId) ?? fallbackSession,
      model,
      fast,
      cost: messageCost(model, tokens, fast),
    },
  }
}

/**
 * Two lines of the same message: Claude Code writes one per content block, and an early one can carry partial
 * usage (output still streaming), so each count takes the larger value.
 */
export function mergeRecords(a: UsageRecord, b: UsageRecord): UsageRecord {
  if (a === b) return a
  const tokens: TokenCounts = {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  }
  const same =
    tokens.input === a.input &&
    tokens.output === a.output &&
    tokens.cacheRead === a.cacheRead &&
    tokens.cacheWrite5m === a.cacheWrite5m &&
    tokens.cacheWrite1h === a.cacheWrite1h &&
    (a.fast || !b.fast)
  if (same) return a
  const fast = a.fast || b.fast
  const ts = Number.isNaN(a.ts) ? b.ts : Number.isNaN(b.ts) ? a.ts : Math.min(a.ts, b.ts)
  return { ...a, ...tokens, ts, fast, cost: messageCost(a.model, tokens, fast) }
}

/**
 * Streams the lines of `path` from byte `start` to `end`, without ever holding more than one line (capped at
 * MAX_LINE_BYTES). Returns the offset just past the last complete line, and the unterminated rest (if any and
 * not too long), which may still be growing.
 */
export async function streamLines(
  path: string,
  start: number,
  end: number,
  onLine: (line: string, lineStart: number) => void,
): Promise<{ offset: number; tail: string | null }> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES)
    let pos = start
    let lineStart = start
    let parts: Buffer[] = []
    let partLen = 0
    let skipping = false
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, end - pos), pos)
      if (bytesRead === 0) break
      const chunk = buf.subarray(0, bytesRead)
      let i = 0
      while (i < chunk.length) {
        const nl = chunk.indexOf(0x0a, i)
        const stop = nl === -1 ? chunk.length : nl
        if (nl !== -1 && parts.length === 0 && !skipping) {
          // The whole line is in this chunk: decode it in place.
          if (stop - i <= MAX_LINE_BYTES) onLine(chunk.toString('utf8', i, stop), lineStart)
        } else {
          if (!skipping && partLen + (stop - i) > MAX_LINE_BYTES) {
            skipping = true
            parts = []
            partLen = 0
          }
          if (!skipping) {
            parts.push(Buffer.from(chunk.subarray(i, stop))) // a copy: `buf` is reused for the next read
            partLen += stop - i
          }
          if (nl === -1) break
          if (!skipping) onLine(Buffer.concat(parts, partLen).toString('utf8'), lineStart)
          parts = []
          partLen = 0
          skipping = false
        }
        lineStart = pos + nl + 1
        i = nl + 1
      }
      pos += bytesRead
    }
    const tail = !skipping && partLen > 0 ? Buffer.concat(parts, partLen).toString('utf8') : null
    return { offset: lineStart, tail }
  } finally {
    await fh.close()
  }
}

interface FileState {
  ino: number
  size: number
  mtimeMs: number
  /** Bytes up to here are parsed; an unterminated last line is parsed again on the next read. */
  offset: number
  /** The file's messages, by de-duplication key. Kept across incremental reads. */
  records: Map<string, UsageRecord>
}

export interface UsageServiceOptions {
  /** The Claude config folder; transcripts are read from `<claudeDir>/projects`. Default: claudeConfigDir(). */
  claudeDir?: string
  /** The clock for today / this week / this month. */
  now?: () => Date
  /** Calls closer together than this reuse the last scan. Default 1 s; 0 always rescans. */
  minRefreshMs?: number
}

/** Local midnight `days` days before `now`'s day. */
const startOfDay = (now: Date, daysBack = 0): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime()

const periodStarts = (now: Date): Record<UsagePeriod, number> => ({
  today: startOfDay(now),
  week: startOfDay(now, 6),
  month: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
  all: -Infinity,
})

/** Running totals for one bucket (a target or group in one period). */
class Accumulator implements Omit<UsageTotals, 'sessions' | 'firstSeen' | 'lastSeen'> {
  input = 0
  output = 0
  cacheRead = 0
  cacheWrite5m = 0
  cacheWrite1h = 0
  cost = 0
  unpricedTokens = 0
  messages = 0
  sessions = new Set<string>()
  first = Infinity
  last = -Infinity
  models: Map<string, Accumulator> | null

  constructor(withModels: boolean) {
    this.models = withModels ? new Map() : null
  }

  add(r: UsageRecord): void {
    this.input += r.input
    this.output += r.output
    this.cacheRead += r.cacheRead
    this.cacheWrite5m += r.cacheWrite5m
    this.cacheWrite1h += r.cacheWrite1h
    if (r.cost === null) this.unpricedTokens += totalTokens(r)
    else this.cost += r.cost
    this.messages++
    if (r.session) this.sessions.add(r.session)
    if (!Number.isNaN(r.ts)) {
      if (r.ts < this.first) this.first = r.ts
      if (r.ts > this.last) this.last = r.ts
    }
    if (this.models) {
      let m = this.models.get(r.model)
      if (!m) this.models.set(r.model, (m = new Accumulator(false)))
      m.add(r)
    }
  }

  totals(): UsageTotals {
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite5m: this.cacheWrite5m,
      cacheWrite1h: this.cacheWrite1h,
      cost: this.cost,
      unpricedTokens: this.unpricedTokens,
      messages: this.messages,
      sessions: this.sessions.size,
      firstSeen: Number.isFinite(this.first) ? new Date(this.first).toISOString() : null,
      lastSeen: Number.isFinite(this.last) ? new Date(this.last).toISOString() : null,
    }
  }

  bucket(): UsageBucket {
    const models: UsageModelTotals[] = [...(this.models ?? new Map<string, Accumulator>()).entries()].map(
      ([model, acc]) => ({ ...acc.totals(), model, priced: acc.unpricedTokens === 0 }),
    )
    models.sort((a, b) => b.cost - a.cost || totalTokens(b) - totalTokens(a) || a.model.localeCompare(b.model))
    return { ...this.totals(), models }
  }
}

/** Strips a trailing separator (but keeps "/"). */
const normalizeRoot = (root: string): string => {
  const r = resolve(root)
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r
}

const contains = (root: string, cwd: string): boolean =>
  cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Sums usage per root and per group. Each message counts for the most specific root containing its cwd (a task
 * worktree inside a folder counts for the task), and for every group listing that root.
 */
export function aggregateUsage(
  records: Iterable<UsageRecord>,
  roots: readonly string[],
  groups: Readonly<Record<string, readonly string[]>>,
  now: Date,
): UsageSummaries {
  const starts = periodStarts(now)
  type Sink = Record<UsagePeriod, Accumulator>
  const newSink = (): Sink =>
    Object.fromEntries(USAGE_PERIODS.map((p) => [p, new Accumulator(true)])) as Record<UsagePeriod, Accumulator>
  // Normalized root -> every sink fed by it (the root's own entries, then its groups).
  const sinksOf = new Map<string, Sink[]>()
  const rootSinks = new Map<string, Sink>()
  const groupSinks = new Map<string, Sink>()
  const sinksFor = (root: string): Sink[] => {
    const n = normalizeRoot(root)
    let list = sinksOf.get(n)
    if (!list) sinksOf.set(n, (list = []))
    return list
  }
  for (const root of roots) {
    if (rootSinks.has(root)) continue
    const sink = newSink()
    rootSinks.set(root, sink)
    sinksFor(root).push(sink)
  }
  for (const [name, members] of Object.entries(groups)) {
    const sink = newSink()
    groupSinks.set(name, sink)
    for (const n of new Set(members.map(normalizeRoot))) sinksFor(n).push(sink)
  }
  const ordered = [...sinksOf.keys()].sort((a, b) => b.length - a.length)
  const rootOfCwd = new Map<string, string | null>()
  const match = (cwd: string): string | null => {
    let hit = rootOfCwd.get(cwd)
    if (hit === undefined) {
      hit = ordered.find((r) => contains(r, cwd)) ?? null
      rootOfCwd.set(cwd, hit)
    }
    return hit
  }

  for (const r of records) {
    const root = match(r.cwd)
    if (root === null) continue
    for (const sink of sinksOf.get(root)!) {
      for (const p of USAGE_PERIODS) if (p === 'all' || r.ts >= starts[p]) sink[p].add(r)
    }
  }
  const finish = (sink: Sink): UsageSummary =>
    Object.fromEntries(USAGE_PERIODS.map((p) => [p, sink[p].bucket()])) as Record<UsagePeriod, UsageBucket>
  return {
    roots: Object.fromEntries([...rootSinks].map(([k, s]) => [k, finish(s)])),
    groups: Object.fromEntries([...groupSinks].map(([k, s]) => [k, finish(s)])),
  }
}

/**
 * Reads Claude Code's transcripts (`<claudeDir>/projects/<encoded cwd>/**.jsonl`), read-only, and sums their
 * usage. Only project folders whose names match a requested root (or a folder inside one) are read. Each file
 * is parsed once and then only for the bytes appended since; a file that shrank or was replaced is parsed again
 * from the start. Results are cached until a transcript changes (or the day does).
 */
export class UsageService implements UsageApi {
  private readonly projectsDir: string
  private readonly now: () => Date
  private readonly minRefreshMs: number
  private files = new Map<string, FileState>()
  /** Strings repeated on every line (cwd, session, model), shared instead of one copy per message. */
  private interned = new Map<string, string>()
  /** Bumped whenever any file's records change. */
  private generation = 0
  private merged: { generation: number; records: UsageRecord[] } | null = null
  private cache: { key: string; result: UsageSummaries } | null = null
  private lastScan: { at: number; dirsKey: string } | null = null
  private scanning: Promise<void> | null = null
  private warnedCap = false

  constructor(options: UsageServiceOptions = {}) {
    this.projectsDir = join(options.claudeDir ?? claudeConfigDir(), 'projects')
    this.now = options.now ?? (() => new Date())
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS
  }

  async summarize(
    roots: readonly string[],
    groups: Readonly<Record<string, readonly string[]>> = {},
  ): Promise<UsageSummaries> {
    const all = [...new Set([...roots, ...Object.values(groups).flat()])].map(normalizeRoot)
    await this.refresh(all)
    const now = this.now()
    const key = JSON.stringify([this.generation, startOfDay(now), roots, groups])
    if (this.cache?.key === key) return this.cache.result
    const result = aggregateUsage(this.mergedRecords(), roots, groups, now)
    this.cache = { key, result }
    return result
  }

  /** Every message once, across files (a resumed or forked session can repeat earlier messages). */
  private mergedRecords(): UsageRecord[] {
    if (this.merged?.generation === this.generation) return this.merged.records
    const byKey = new Map<string, UsageRecord>()
    for (const [path, state] of this.files) {
      for (const [key, record] of state.records) {
        // Keyless lines are unique to their file and offset.
        const k = key.startsWith('@') ? `${path}${key}` : key
        const prev = byKey.get(k)
        byKey.set(k, prev ? mergeRecords(prev, record) : record)
      }
    }
    const records = [...byKey.values()]
    this.merged = { generation: this.generation, records }
    return records
  }

  private intern(s: string): string {
    const hit = this.interned.get(s)
    if (hit !== undefined) return hit
    this.interned.set(s, s)
    return s
  }

  /** Brings the cached files in line with disk; concurrent calls share one scan. */
  private async refresh(roots: string[]): Promise<void> {
    const encoded = [...new Set(roots.map(encodeProjectPath))]
    const dirsKey = encoded.sort().join('\n')
    const fresh = (): boolean =>
      this.lastScan !== null && this.lastScan.dirsKey === dirsKey && Date.now() - this.lastScan.at < this.minRefreshMs
    // Wait for a scan already running; it may have covered these roots just now.
    while (this.scanning) await this.scanning.catch(() => {})
    if (fresh()) return
    this.scanning = this.scan(encoded)
      .then(() => {
        this.lastScan = { at: Date.now(), dirsKey }
      })
      .finally(() => {
        this.scanning = null
      })
    return this.scanning
  }

  private async scan(encodedRoots: string[]): Promise<void> {
    let entries: Dirent[] = []
    try {
      entries = await readdir(this.projectsDir, { withFileTypes: true })
    } catch {
      // No transcripts yet (Claude Code never ran), or unreadable: nothing to count.
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && encodedRoots.some((r) => projectDirMatches(e.name, r)))
      .map((e) => join(this.projectsDir, e.name))
    const found: string[] = []
    for (const dir of dirs) await this.collect(dir, 0, found)
    if (found.length > MAX_TRACKED_FILES) {
      if (!this.warnedCap) console.warn(`usage: tracking only ${MAX_TRACKED_FILES} of ${found.length} transcripts`)
      this.warnedCap = true
      found.length = MAX_TRACKED_FILES
    }
    const seen = new Set(found)
    for (const path of [...this.files.keys()]) {
      if (seen.has(path)) continue
      this.files.delete(path) // deleted, or no longer under a requested root
      this.generation++
    }
    // Concurrently: one stat at a time would make a scan of thousands of transcripts as slow as their sum.
    await mapLimit(found, STAT_CONCURRENCY, async (path) => {
      try {
        if (await this.update(path)) this.generation++
      } catch {
        // Unreadable or vanished mid-scan: keep what was read before, try again next time.
      }
    })
  }

  private async collect(dir: string, depth: number, out: string[]): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
      else if (e.isDirectory() && depth < MAX_SCAN_DEPTH) await this.collect(path, depth + 1, out)
    }
  }

  /** Reads what changed in one transcript; true when its records changed. */
  private async update(path: string): Promise<boolean> {
    const st = await stat(path)
    let state = this.files.get(path)
    if (state && st.ino === state.ino && st.size === state.size && st.mtimeMs === state.mtimeMs) return false
    const replaced =
      !state ||
      st.ino !== state.ino ||
      st.size < state.offset ||
      st.mtimeMs < state.mtimeMs ||
      (st.size === state.size && st.mtimeMs !== state.mtimeMs) // rewritten in place
    if (replaced) {
      state = { ino: st.ino, size: 0, mtimeMs: 0, offset: 0, records: new Map() }
    }
    const current = state!
    const session = basename(path, '.jsonl')
    let changed = replaced && this.files.has(path)
    const take = (line: string, lineStart: number): void => {
      const parsed = parseUsageLine(line, session)
      if (!parsed) return
      const r = parsed.record
      r.cwd = this.intern(r.cwd)
      r.session = this.intern(r.session)
      r.model = this.intern(r.model)
      const key = parsed.key ?? `@${lineStart}`
      const prev = current.records.get(key)
      const next = prev ? mergeRecords(prev, r) : r
      if (next !== prev) {
        current.records.set(key, next)
        changed = true
      }
    }
    const { offset, tail } = await streamLines(path, current.offset, st.size, take)
    // An unterminated last line counts if it is already complete JSON; it is read again next time either way.
    if (tail !== null) take(tail, offset)
    current.offset = offset
    current.size = st.size
    current.mtimeMs = st.mtimeMs
    current.ino = st.ino
    this.files.set(path, current)
    return changed
  }
}
