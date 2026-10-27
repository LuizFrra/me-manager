import { readdirSync, statSync, type Dirent, type Stats } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
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
/**
 * Transcripts stat-ed by a scan before it lets other work run. Synchronously: a stat through the thread pool costs
 * several times the CPU of the stat itself, and every scan checks every transcript.
 */
export const STAT_SLICE = 128
/** Folders listed by a scan before it lets other work run, synchronously too (see STAT_SLICE). */
export const DIR_SLICE = 32
/** Changed transcripts read at the same time by a scan. */
export const READ_CONCURRENCY = 16
/** Lets the event loop run (IPC, the terminal's output) between slices of synchronous file system calls. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
/**
 * The cache file's format: bumped whenever its layout or what a transcript line counts for changes, so that a cache
 * written by another version is ignored (and rebuilt) instead of misread.
 */
export const USAGE_CACHE_VERSION = 1
/** The cache is written this long after a scan changed it, so that a burst of changes is written once. */
const DEFAULT_CACHE_SAVE_DELAY_MS = 2_000
/**
 * And then at most this often: a transcript that grew since is read on from its cached offset, so a cache a few
 * minutes old costs only the bytes appended since.
 */
const DEFAULT_CACHE_SAVE_INTERVAL_MS = 5 * 60_000
/** Messages serialized by a cache write before it lets other work run. */
const CACHE_SLICE = 5_000
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

/** Only lines with this key can count (see parseUsageLine). */
const USAGE_KEY = Buffer.from('"usage"')

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * A record with every field set in one literal, so that all records share one compact layout (a spread builds a
 * larger object, its fields added one by one).
 */
const usageRecord = (
  t: TokenCounts,
  ts: number,
  cwd: string,
  session: string,
  model: string,
  fast: boolean,
): UsageRecord => ({
  input: t.input,
  output: t.output,
  cacheRead: t.cacheRead,
  cacheWrite5m: t.cacheWrite5m,
  cacheWrite1h: t.cacheWrite1h,
  ts,
  cwd,
  session,
  model,
  fast,
  cost: messageCost(model, t, fast),
})

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
  const id = str(message.id)
  const requestId = str(entry.requestId)
  // Joined, not concatenated: V8 keeps a concatenation as a rope over its parts, larger than the flat string.
  const key = id || requestId ? [id ?? '', requestId ?? ''].join('\u0000') : null
  const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const session = str(entry.sessionId) ?? fallbackSession
  return { key, record: usageRecord(tokens, ts, cwd, session, model, usage.speed === 'fast') }
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
  return usageRecord(tokens, ts, a.cwd, a.session, a.model, fast)
}

/**
 * Streams the lines of `path` from byte `start` to `end`, without ever holding more than one line (capped at
 * MAX_LINE_BYTES). Returns the offset just past the last complete line, and the unterminated rest (if any and
 * not too long), which may still be growing. With `filter`, only complete lines containing those bytes are
 * decoded and passed on: most of a transcript's bytes are tool output, never worth turning into strings.
 */
export async function streamLines(
  path: string,
  start: number,
  end: number,
  onLine: (line: string, lineStart: number) => void,
  filter?: Buffer,
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
      // The filter's next occurrence in the chunk (-1: none left), searched again only once a line passes it.
      let hit = filter ? chunk.indexOf(filter) : 0
      const wanted = (from: number, to: number): boolean => {
        if (!filter) return true
        if (hit !== -1 && hit < from) hit = chunk.indexOf(filter, from)
        return hit !== -1 && hit + filter.length <= to
      }
      let i = 0
      while (i < chunk.length) {
        const nl = chunk.indexOf(0x0a, i)
        const stop = nl === -1 ? chunk.length : nl
        if (nl !== -1 && parts.length === 0 && !skipping) {
          // The whole line is in this chunk: decode it in place.
          if (stop - i <= MAX_LINE_BYTES && wanted(i, stop)) onLine(chunk.toString('utf8', i, stop), lineStart)
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
          if (!skipping) {
            const whole = Buffer.concat(parts, partLen)
            if (!filter || whole.includes(filter)) onLine(whole.toString('utf8'), lineStart)
          }
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

/**
 * Values per message in a cache entry's `r`: its key, the five token counts, its time (null: none), the indexes of
 * its cwd, session and model in the entry's `s`, and 1 for fast mode (else 0).
 */
const RECORD_FIELDS = 11

/** One transcript's cache entry, as JSON: its strings once each, its messages flattened (see RECORD_FIELDS). */
function serializeFile(state: FileState): string {
  const strings = new Map<string, number>()
  const index = (s: string): number => {
    let i = strings.get(s)
    if (i === undefined) strings.set(s, (i = strings.size))
    return i
  }
  const r: (string | number | null)[] = []
  for (const [key, x] of state.records) {
    const ts = Number.isNaN(x.ts) ? null : x.ts
    r.push(key, x.input, x.output, x.cacheRead, x.cacheWrite5m, x.cacheWrite1h, ts)
    r.push(index(x.cwd), index(x.session), index(x.model), x.fast ? 1 : 0)
  }
  const { ino, size, mtimeMs, offset } = state
  return JSON.stringify({ ino, size, mtimeMs, offset, s: [...strings.keys()], r })
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A cache entry back as a file's state; null when anything in it is off (the transcript is then read again). */
function parseCachedFile(entry: unknown, intern: (s: string) => string): FileState | null {
  if (!entry || typeof entry !== 'object') return null
  const { ino, size, mtimeMs, offset, s, r } = entry as Record<string, unknown>
  if (!isCount(ino) || !isCount(size) || !isCount(mtimeMs) || !isCount(offset) || offset > size) return null
  if (!Array.isArray(s) || !Array.isArray(r) || r.length % RECORD_FIELDS !== 0) return null
  if (!s.every((x) => typeof x === 'string')) return null
  const strings = (s as string[]).map(intern)
  const str = (v: unknown): string | undefined => (Number.isInteger(v) ? strings[v as number] : undefined)
  const records = new Map<string, UsageRecord>()
  for (let i = 0; i < r.length; i += RECORD_FIELDS) {
    const key = r[i]
    const ts = r[i + 6]
    const fast = r[i + 10]
    const [cwd, session, model] = [str(r[i + 7]), str(r[i + 8]), str(r[i + 9])]
    if (typeof key !== 'string' || key === '' || (ts !== null && typeof ts !== 'number')) return null
    if (!cwd || session === undefined || !model || (fast !== 0 && fast !== 1)) return null
    for (let j = i + 1; j <= i + 5; j++) if (!isCount(r[j])) return null
    const tokens: TokenCounts = {
      input: r[i + 1],
      output: r[i + 2],
      cacheRead: r[i + 3],
      cacheWrite5m: r[i + 4],
      cacheWrite1h: r[i + 5],
    }
    // The cost is worked out again: prices may have changed since.
    records.set(key, usageRecord(tokens, ts ?? NaN, cwd, session, model, fast === 1))
  }
  return { ino, size, mtimeMs, offset, records }
}

export interface UsageServiceOptions {
  /** The Claude config folder; transcripts are read from `<claudeDir>/projects`. Default: claudeConfigDir(). */
  claudeDir?: string
  /**
   * Where to keep what was read from each transcript across restarts, so that one unchanged since is not parsed
   * again. Default: none (nothing is written).
   */
  cacheFile?: string
  /** How long after a change the cache is written. Default 2 s. */
  cacheSaveDelayMs?: number
  /** The least time between two writes of the cache. Default 5 minutes. */
  cacheSaveIntervalMs?: number
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

/** A period's bit in a record's period mask; `all` has none, as every record is in it. */
const PERIOD_BIT: Record<UsagePeriod, number> = { today: 1, week: 2, month: 4, all: 0 }

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

  /** Adds what `o` counted, as if its records had been added here. */
  merge(o: Accumulator): void {
    this.input += o.input
    this.output += o.output
    this.cacheRead += o.cacheRead
    this.cacheWrite5m += o.cacheWrite5m
    this.cacheWrite1h += o.cacheWrite1h
    this.cost += o.cost
    this.unpricedTokens += o.unpricedTokens
    this.messages += o.messages
    for (const s of o.sessions) this.sessions.add(s)
    if (o.first < this.first) this.first = o.first
    if (o.last > this.last) this.last = o.last
    if (this.models && o.models) {
      for (const [model, acc] of o.models) {
        let m = this.models.get(model)
        if (!m) this.models.set(model, (m = new Accumulator(false)))
        m.merge(acc)
      }
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

/** Totals by period mask (sparse): today implies this week and this month, but a week can start last month. */
type Cells = Accumulator[]

/** Adds a record to its cell for the periods it falls in; NaN (no timestamp) is in no period but `all`. */
function addToCells(cells: Cells, r: UsageRecord, starts: Record<UsagePeriod, number>): void {
  const mask =
    (r.ts >= starts.today ? PERIOD_BIT.today : 0) |
    (r.ts >= starts.week ? PERIOD_BIT.week : 0) |
    (r.ts >= starts.month ? PERIOD_BIT.month : 0)
  ;(cells[mask] ??= new Accumulator(true)).add(r)
}

/** Each cwd's totals by period mask, for the day of `now`. */
export function cellsByCwd(records: Iterable<UsageRecord>, now: Date): Map<string, Cells> {
  const starts = periodStarts(now)
  const out = new Map<string, Cells>()
  for (const r of records) {
    let cells = out.get(r.cwd)
    if (!cells) out.set(r.cwd, (cells = []))
    addToCells(cells, r, starts)
  }
  return out
}

/**
 * Sums usage per root and per group from each cwd's totals (see cellsByCwd). Each message counts for the most
 * specific root containing its cwd (a task worktree inside a folder counts for the task), and for every group
 * listing that root.
 *
 * Each record was added once, to its cwd's cell for the periods it falls in. The periods, roots and groups are sums
 * of those few cells, instead of every record being added to every period of its root and of each of its groups.
 */
export function summarizeCells(
  cells: ReadonlyMap<string, Cells>,
  roots: readonly string[],
  groups: Readonly<Record<string, readonly string[]>>,
): UsageSummaries {
  type Sink = Record<UsagePeriod, Accumulator>
  const groupRoots = Object.entries(groups).map(
    ([name, members]) => [name, new Set(members.map(normalizeRoot))] as const,
  )
  const known = new Set(roots.map(normalizeRoot))
  for (const [, members] of groupRoots) for (const n of members) known.add(n)
  const ordered = [...known].sort((a, b) => b.length - a.length)
  // Normalized root -> the totals of the cwds it is the most specific root of.
  const cellsOf = new Map<string, Cells[]>()
  for (const [cwd, c] of cells) {
    const root = ordered.find((r) => contains(r, cwd))
    if (root === undefined) continue
    let list = cellsOf.get(root)
    if (!list) cellsOf.set(root, (list = []))
    list.push(c)
  }

  const summaryOf = (members: Iterable<string>): UsageSummary => {
    const sink = Object.fromEntries(USAGE_PERIODS.map((p) => [p, new Accumulator(true)])) as Sink
    for (const n of members) {
      for (const c of cellsOf.get(n) ?? []) {
        c.forEach((cell, mask) => {
          for (const p of USAGE_PERIODS) if (p === 'all' || mask & PERIOD_BIT[p]) sink[p].merge(cell)
        })
      }
    }
    return Object.fromEntries(USAGE_PERIODS.map((p) => [p, sink[p].bucket()])) as Record<UsagePeriod, UsageBucket>
  }
  return {
    roots: Object.fromEntries([...new Set(roots)].map((root) => [root, summaryOf([normalizeRoot(root)])])),
    groups: Object.fromEntries(groupRoots.map(([name, members]) => [name, summaryOf(members)])),
  }
}

/** Sums usage per root and per group (see summarizeCells). */
export const aggregateUsage = (
  records: Iterable<UsageRecord>,
  roots: readonly string[],
  groups: Readonly<Record<string, readonly string[]>>,
  now: Date,
): UsageSummaries => summarizeCells(cellsByCwd(records, now), roots, groups)

/**
 * Reads Claude Code's transcripts (`<claudeDir>/projects/<encoded cwd>/**.jsonl`), read-only, and sums their
 * usage. Only project folders whose names match a requested root (or a folder inside one) are read. Each file
 * is parsed once and then only for the bytes appended since; a file that shrank or was replaced is parsed again
 * from the start. Results are cached until a transcript changes (or the day does).
 *
 * With a cache file, what was read from each transcript survives a restart: one unchanged since (same inode, size
 * and mtime) is not read at all, and one that grew is read on from where the cache left it.
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
  /**
   * Every message once, across files (a resumed or forked session can repeat earlier messages), kept up to date as
   * lines are read: merging takes the larger counts, so a line merged in again changes nothing.
   */
  private merged = new Map<string, UsageRecord>()
  /** Set when a file's records were dropped (deleted, replaced, out of scope): `merged` is then rebuilt. */
  private mergedStale = false
  /** `merged` by cwd, so that a change sums again only the messages of its cwd. */
  private mergedByCwd = new Map<string, Map<string, UsageRecord>>()
  /**
   * Each cwd's totals for the day `cellsDay` (see cellsByCwd); a cwd whose messages changed since is left out, and
   * summed again on the next summarize.
   */
  private cells = new Map<string, Cells>()
  private cellsDay = NaN
  private cache: { key: string; result: UsageSummaries } | null = null
  private lastScan: { at: number; dirsKey: string } | null = null
  private scanning: Promise<void> | null = null
  private warnedCap = false
  private readonly cacheFile: string | null
  private readonly cacheSaveDelayMs: number
  private readonly cacheSaveIntervalMs: number
  /**
   * Transcripts in the cache file that no scan has found yet (their folders were not asked about), taken into
   * `files` as scans find them; null until the cache file is read, on the first scan.
   */
  private cachedFiles: Map<string, FileState> | null = null
  /** Set when what the cache file should hold changed since it was last written. */
  private cacheDirty = false
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> | null = null
  private lastSaveAt = -Infinity

  constructor(options: UsageServiceOptions = {}) {
    this.projectsDir = join(options.claudeDir ?? claudeConfigDir(), 'projects')
    this.now = options.now ?? (() => new Date())
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS
    this.cacheFile = options.cacheFile ?? null
    this.cacheSaveDelayMs = options.cacheSaveDelayMs ?? DEFAULT_CACHE_SAVE_DELAY_MS
    this.cacheSaveIntervalMs = options.cacheSaveIntervalMs ?? DEFAULT_CACHE_SAVE_INTERVAL_MS
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
    const result = summarizeCells(this.cwdCells(now), roots, groups)
    this.cache = { key, result }
    return result
  }

  /** Every cwd's totals, summing again only the cwds whose messages changed (all of them on a new day). */
  private cwdCells(now: Date): ReadonlyMap<string, Cells> {
    if (this.mergedStale) {
      this.mergedStale = false
      this.merged.clear()
      this.mergedByCwd.clear()
      this.cells.clear()
      for (const [path, state] of this.files) for (const [key, record] of state.records) this.mergeIn(path, key, record)
    }
    const day = startOfDay(now)
    if (day !== this.cellsDay) {
      this.cells.clear()
      this.cellsDay = day
    }
    const starts = periodStarts(now)
    for (const [cwd, records] of this.mergedByCwd) {
      if (this.cells.has(cwd)) continue
      const cells: Cells = []
      for (const r of records.values()) addToCells(cells, r, starts)
      this.cells.set(cwd, cells)
    }
    return this.cells
  }

  private mergeIn(path: string, key: string, record: UsageRecord): void {
    // Keyless lines are unique to their file and offset.
    const k = key.startsWith('@') ? `${path}${key}` : key
    const prev = this.merged.get(k)
    const next = prev ? mergeRecords(prev, record) : record
    if (next === prev) return
    this.merged.set(k, next)
    // A merged record keeps the first one's cwd, so a key never moves to another cwd.
    let byCwd = this.mergedByCwd.get(next.cwd)
    if (!byCwd) this.mergedByCwd.set(next.cwd, (byCwd = new Map()))
    byCwd.set(k, next)
    this.cells.delete(next.cwd)
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
        this.scheduleSave()
      })
      .finally(() => {
        this.scanning = null
      })
    return this.scanning
  }

  private async scan(encodedRoots: string[]): Promise<void> {
    this.cachedFiles ??= await this.loadCache()
    let entries: Dirent[] = []
    try {
      entries = await readdir(this.projectsDir, { withFileTypes: true })
    } catch {
      // No transcripts yet (Claude Code never ran), or unreadable: nothing to count.
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && encodedRoots.some((r) => projectDirMatches(e.name, r)))
      .map((e) => join(this.projectsDir, e.name))
    const found = await this.collect(dirs)
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
      this.mergedStale = true
      this.cacheDirty = true
    }
    // Cached transcripts of the folders just listed that are not there any more were deleted since.
    const listed = new Set(dirs)
    for (const path of this.cachedFiles.keys()) {
      if (seen.has(path) || !listed.has(join(this.projectsDir, path.slice(this.projectsDir.length + 1).split(sep)[0])))
        continue
      this.cachedFiles.delete(path)
      this.cacheDirty = true
    }
    const changed: { path: string; st: Stats }[] = []
    for (let i = 0; i < found.length; i += STAT_SLICE) {
      if (i > 0) await turn()
      for (const path of found.slice(i, i + STAT_SLICE)) {
        let st: Stats | undefined
        try {
          st = statSync(path, { throwIfNoEntry: false })
        } catch {
          // Unreadable: keep what was read before, try again next time.
        }
        const known = this.files.get(path) ?? this.adopt(path)
        if (!st || (known && st.ino === known.ino && st.size === known.size && st.mtimeMs === known.mtimeMs)) continue
        changed.push({ path, st })
      }
    }
    // Concurrently: one read at a time would make a first scan of thousands of transcripts as slow as their sum.
    await mapLimit(changed, READ_CONCURRENCY, async ({ path, st }) => {
      try {
        await this.update(path, st)
      } catch {
        // Unreadable or vanished mid-scan: keep what was read before, try again next time.
      }
    })
  }

  /** A transcript's state from the cache file, now tracked, its messages merged in; undefined when it has none. */
  private adopt(path: string): FileState | undefined {
    const state = this.cachedFiles?.get(path)
    if (!state) return undefined
    this.cachedFiles!.delete(path)
    this.files.set(path, state)
    for (const [key, record] of state.records) this.mergeIn(path, key, record)
    this.generation++
    return state
  }

  /** The cache file's transcripts; none when it is missing, unreadable, corrupt or from another version or folder. */
  private async loadCache(): Promise<Map<string, FileState>> {
    const files = new Map<string, FileState>()
    if (!this.cacheFile) return files
    let data: unknown
    try {
      data = JSON.parse(await readFile(this.cacheFile, 'utf8'))
    } catch {
      return files // none yet, or unusable: rebuilt by reading the transcripts
    }
    const d = data as Record<string, unknown> | null
    if (!d || typeof d !== 'object' || d.v !== USAGE_CACHE_VERSION || d.dir !== this.projectsDir) return files
    if (!d.files || typeof d.files !== 'object') return files
    for (const [path, entry] of Object.entries(d.files)) {
      const state = path.startsWith(this.projectsDir + sep) ? parseCachedFile(entry, (s) => this.intern(s)) : null
      if (state) files.set(path, state)
      else this.cacheDirty = true // left out of the next write; the transcript is read again if found
    }
    return files
  }

  private scheduleSave(): void {
    if (!this.cacheFile || !this.cacheDirty || this.saveTimer) return
    const wait = Math.max(this.cacheSaveDelayMs, this.lastSaveAt + this.cacheSaveIntervalMs - Date.now())
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCache()
    }, wait)
    this.saveTimer.unref()
  }

  /** Writes the cache file now, if what it should hold changed since the last write. One write at a time. */
  async saveCache(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    while (this.saving) await this.saving
    const file = this.cacheFile
    if (!file || !this.cacheDirty) return
    this.cacheDirty = false
    this.saving = this.writeCache(file)
      .catch((err) => {
        this.cacheDirty = true
        console.warn(`usage: could not write ${file}: ${(err as Error).message}`)
      })
      .finally(() => {
        this.saving = null
        this.lastSaveAt = Date.now()
      })
    await this.saving
  }

  /**
   * Written whole to a temporary file renamed over the old one, so a crash never leaves half a cache. Each entry is
   * serialized in one go, so it is consistent even while a scan runs between slices (re-reading lines a cache
   * already has changes nothing: merging takes the larger counts).
   */
  private async writeCache(file: string): Promise<void> {
    const entries = [...this.files, ...(this.cachedFiles ?? [])]
    const parts: string[] = []
    let slice = 0
    for (const [path, state] of entries) {
      parts.push(`${JSON.stringify(path)}:${serializeFile(state)}`)
      slice += state.records.size
      if (slice >= CACHE_SLICE) {
        slice = 0
        await turn()
      }
    }
    const head = JSON.stringify({ v: USAGE_CACHE_VERSION, dir: this.projectsDir }).slice(0, -1)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${head},"files":{${parts.join(',')}}}\n`)
    await rename(tmp, file)
  }

  /** The transcripts in `dirs` and their subfolders, level by level (each session's subagents have a folder). */
  private async collect(dirs: string[]): Promise<string[]> {
    const out: string[] = []
    let level = dirs
    for (let depth = 0; level.length > 0; depth++) {
      const next: string[] = []
      for (let i = 0; i < level.length; i += DIR_SLICE) {
        if (i > 0 || depth > 0) await turn()
        for (const dir of level.slice(i, i + DIR_SLICE)) {
          let entries: Dirent[]
          try {
            entries = readdirSync(dir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const e of entries) {
            const path = join(dir, e.name)
            if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
            else if (e.isDirectory() && depth < MAX_SCAN_DEPTH) next.push(path)
          }
        }
      }
      level = next
    }
    return out
  }

  /** Reads what changed in one transcript (`st` is its stat), bumping the generation when its records changed. */
  private async update(path: string, st: Stats): Promise<void> {
    const known = this.files.get(path)
    const replaced =
      !known ||
      st.ino !== known.ino ||
      st.size < known.offset ||
      st.mtimeMs < known.mtimeMs ||
      (st.size === known.size && st.mtimeMs !== known.mtimeMs) // rewritten in place
    let current = known!
    this.cacheDirty = true
    if (replaced) {
      if (known) this.mergedStale = true // its old records are merged in
      current = { ino: st.ino, size: 0, mtimeMs: 0, offset: 0, records: new Map() }
      // Kept before reading, so that whatever a failed read merged in is accounted for.
      this.files.set(path, current)
    }
    const session = basename(path, '.jsonl')
    let changed = replaced && known !== undefined
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
        this.mergeIn(path, key, next)
        changed = true
      }
    }
    try {
      const { offset, tail } = await streamLines(path, current.offset, st.size, take, USAGE_KEY)
      // An unterminated last line counts if it is already complete JSON; it is read again next time either way.
      if (tail !== null) take(tail, offset)
      current.offset = offset
      current.size = st.size
      current.mtimeMs = st.mtimeMs
    } finally {
      if (changed) this.generation++
    }
  }
}
