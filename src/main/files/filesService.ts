import type { Stats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { IMAGE_MIME, MAX_IMAGE_BYTES } from '../../shared/images'
import {
  checkSearchQuery,
  makeMatch,
  MAX_SEARCH_MATCHES,
  normalizeSearchOptions,
  searchPattern,
} from '../../shared/search'
import type {
  ChangedFile,
  ChangeList,
  ChangeStatus,
  FileContent,
  FileList,
  SearchMatch,
  SearchOptions,
  SearchResult,
} from '../../shared/types'
import type { FilesApi } from '../contracts'
import { CommandError, run, streamNul } from '../exec'
import { GIT_ENV } from '../git/gitEnv'
import { resolveBaseRef } from '../git/refs'
import { LineMatcher, SearchCancelledError, SearchTimeoutError, type LineHit } from './lineMatcher'

export { MAX_IMAGE_BYTES }
export const MAX_TEXT_BYTES = 1_000_000
export const BINARY_SNIFF_BYTES = 8_192
export const MAX_WALK_ENTRIES = 20_000
/** Repos list at most this many files; ls-files is stopped there. */
export const MAX_REPO_ENTRIES = 50_000
/** Untracked files up to this size get a line count in the change list; larger ones report `added: 0`. */
export const MAX_COUNT_BYTES = 256 * 1024
/** A content search gives up after this long. */
export const SEARCH_TIMEOUT_MS = 10_000
/** Folder files read (and matched) at a time by a content search. */
const SEARCH_BATCH = 32
/** Untracked-file stats remembered between polls. */
const UNTRACKED_CACHE_MAX = 5_000

const OUTSIDE = 'Path is outside the folder'
const GIT_TIMEOUT_MS = 30_000
const LSTAT_BATCH = 256

/** Flags that pin diff output to the plain format the renderer parses, whatever the user's git config says. */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

const gitArgs = (cwd: string, args: string[]): string[] => [
  '-C',
  cwd,
  '-c',
  'core.quotepath=false',
  // Otherwise empty context lines come out as '' instead of ' ', which the renderer's parser can't place.
  '-c',
  'diff.suppressBlankEmpty=false',
  '--literal-pathspecs',
  ...args,
]

function git(cwd: string, args: string[], okExitCodes?: number[]): Promise<string> {
  return run('git', gitArgs(cwd, args), { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS, okExitCodes })
}

/** Streams the NUL-separated items git prints; `onItem` returns false to stop git early. */
function gitStream(
  cwd: string,
  args: string[],
  onItem: (item: string) => boolean | void,
): Promise<{ stopped: boolean }> {
  return streamNul('git', gitArgs(cwd, args), onItem, { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS })
}

const GITLINK_MODE = '160000'

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s !== '')
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

export type SafePath =
  | { abs: string; rel: string; lexical: string; missing?: undefined }
  | { missing: true; abs: string; rel: string; lexical: string }

/**
 * Resolves `rel` inside `root`, refusing anything that escapes it lexically or through a symlink.
 * `rel` in the result is normalized and POSIX-separated, suitable as a git pathspec.
 * `lexical` is the path under the real root before resolving symlinks (for lstat).
 * A path that doesn't exist yields `missing: true` (`abs` is then the lexical candidate).
 */
export async function safePath(root: string, rel: string): Promise<SafePath> {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) throw new Error(OUTSIDE)
  const realRoot = await realpath(root)
  const candidate = resolve(realRoot, rel)
  const inside = (p: string): boolean =>
    p === realRoot || p.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
  if (!inside(candidate)) throw new Error(OUTSIDE)
  const normRel = relative(realRoot, candidate).split(sep).join('/')
  let real: string
  try {
    real = await realpath(candidate)
  } catch (err) {
    const code = errCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { missing: true, abs: candidate, rel: normRel, lexical: candidate }
    throw err
  }
  if (!inside(real)) throw new Error(OUTSIDE)
  return { abs: real, rel: normRel, lexical: candidate }
}

/** Reads at most `max` bytes from the start of a file without loading the rest. */
async function readHead(abs: string, max: number): Promise<Buffer> {
  const fh = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(max)
    let total = 0
    while (total < max) {
      const { bytesRead } = await fh.read(buf, total, max - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return buf.subarray(0, total)
  } finally {
    await fh.close()
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/** Line count as git's numstat would report it for a new file (a last line without a newline counts). */
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0
  let n = 0
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

async function walk(root: string, max: number): Promise<FileList> {
  const out: string[] = []
  const stack: string[] = ['']
  let truncated = false
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true })
    } catch {
      continue // unreadable (permissions) or vanished mid-walk
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') stack.push(rel)
      } else if (e.name === '.git') {
        continue // a worktree's .git file is git metadata, not content
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (out.length >= max) {
          truncated = true
          break
        }
        out.push(rel)
      }
    }
  }
  return { paths: out.sort(), truncated }
}

/**
 * A folder file's text for a content search (its first MAX_TEXT_BYTES, like the viewer shows), or null when it
 * is binary, not a regular file, unreadable, or a symlink leading outside the root.
 */
async function searchableText(root: string, rel: string): Promise<string | null> {
  try {
    let abs = join(root, rel)
    let s = await lstat(abs)
    if (s.isSymbolicLink()) {
      const p = await safePath(root, rel) // throws when it leads outside the root
      if (p.missing) return null
      abs = p.abs
      s = await stat(abs)
    }
    if (!s.isFile()) return null
    const truncated = s.size > MAX_TEXT_BYTES
    const head = await readHead(abs, Math.min(s.size, MAX_TEXT_BYTES))
    if (looksBinary(head)) return null
    return new TextDecoder('utf-8').decode(head, { stream: truncated })
  } catch {
    return null
  }
}

/**
 * git grep's failure as the user should read it: git's own words, without the command line. git reports a pattern
 * it can't compile as `fatal: -e option, '<query>': <reason>`.
 */
function grepError(err: unknown, query: string): Error {
  const stderr = err instanceof CommandError ? err.stderr.trim() : ''
  if (!stderr) return err instanceof Error ? err : new Error(String(err))
  const detail = (stderr.split('\n').find((l) => l.startsWith('fatal: ')) ?? stderr.split('\n')[0]).replace(
    /^fatal: /,
    '',
  )
  const option = `-e option, '${query}': `
  if (!detail.startsWith(option)) return new Error(`The search failed: ${detail}`)
  return new Error(`Invalid regular expression: ${detail.slice(option.length)}`)
}

type GrepDialect = '-F' | '-E' | '-P'
interface GrepLine {
  path: string
  line: number
  byteColumn: number
  text: string
}
interface GrepOutput {
  found: GrepLine[]
  truncated: boolean
}

/** Whether git failed because it was built without PCRE, so `git grep -P` can't run. */
export const isNoPcreError = (stderr: string): boolean =>
  /Perl-compatible regexes|USE_LIBPCRE|not compiled with .*PCRE/i.test(stderr)

/** SearchResult.note of a repo regex search that used POSIX extended syntax (see grepRepo). */
export const NO_PCRE_NOTE =
  'This git has no Perl-compatible regular expressions, so the search used POSIX extended syntax: \\d, \\w, \\b and lookarounds don’t work in it.'

/** The diff git shows for a new symlink: one line holding its target, without a trailing newline. */
function newSymlinkDiff(rel: string, target: string): string {
  const lines = target.split('\n')
  return [
    `diff --git a/${rel} b/${rel}`,
    'new file mode 120000',
    '--- /dev/null',
    `+++ b/${rel}`,
    `@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@`,
    ...lines.map((l) => `+${l}`),
    '\\ No newline at end of file',
    '',
  ].join('\n')
}

function mapStatus(token: string): ChangeStatus {
  switch (token[0]) {
    case 'A':
    case 'C':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    default:
      return 'M' // M, T (type change), U (unmerged)
  }
}

interface NameStatus {
  path: string
  oldPath?: string
  status: ChangeStatus
}

/** Parses `--name-status -z`: `X\0path\0`, or `R<score>\0old\0new\0` for renames/copies. */
function parseNameStatus(out: string): NameStatus[] {
  const t = splitZ(out)
  const res: NameStatus[] = []
  for (let i = 0; i < t.length;) {
    const token = t[i++]
    if (token[0] === 'R' || token[0] === 'C') {
      const oldPath = t[i++]
      const path = t[i++]
      res.push(token[0] === 'R' ? { path, oldPath, status: 'R' } : { path, status: 'A' })
    } else {
      res.push({ path: t[i++], status: mapStatus(token) })
    }
  }
  return res
}

/** Parses `--numstat -z`: `a\tr\tpath\0`, or `a\tr\t\0old\0new\0` for renames. `-\t-` means binary. */
function parseNumstat(out: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const t = out.split('\0')
  const res = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (let i = 0; i < t.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t[i])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      i += 2 // old path, then new path
      path = t[i]
    }
    const binary = m[1] === '-' && m[2] === '-'
    res.set(path, { added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary })
  }
  return res
}

interface UntrackedStats {
  size: number
  mtimeMs: number
  added: number
  binary: boolean
}

/** Read-only file access for the side panel. Every path is confined to its root. */
export interface FilesServiceOptions {
  /** Cap on listed repo files (default MAX_REPO_ENTRIES). */
  maxRepoEntries?: number
  /** Cap on listed folder files (default MAX_WALK_ENTRIES). */
  maxWalkEntries?: number
  /** How long a content search may take (default SEARCH_TIMEOUT_MS). */
  searchTimeoutMs?: number
  /** Whether `git grep -P` works; looked up on the first regex search when not given (for tests). */
  perlRegex?: boolean
}

export class FilesService implements FilesApi {
  private readonly maxRepoEntries: number
  private readonly maxWalkEntries: number
  private readonly searchTimeoutMs: number
  /** Whether this git runs `grep -P`: undefined until a regex search finds out. */
  private perlRegex: boolean | undefined

  constructor(opts: FilesServiceOptions = {}) {
    this.perlRegex = opts.perlRegex
    this.maxRepoEntries = opts.maxRepoEntries ?? MAX_REPO_ENTRIES
    this.maxWalkEntries = opts.maxWalkEntries ?? MAX_WALK_ENTRIES
    this.searchTimeoutMs = opts.searchTimeoutMs ?? SEARCH_TIMEOUT_MS
  }

  /** Untracked-file stats by `worktree\0path`, so polls don't re-read unchanged files. Insertion order = LRU order. */
  private readonly untrackedCache = new Map<string, UntrackedStats>()

  async listFiles(root: string, isRepo: boolean): Promise<FileList> {
    if (!isRepo) return walk(root, this.maxWalkEntries)
    const max = this.maxRepoEntries
    // Tracked files deleted from the work tree are still in the index; leave them out.
    const deleted = new Set<string>()
    await gitStream(root, ['ls-files', '-z', '--deleted'], (path) => void deleted.add(path))
    const seen = new Set<string>()
    let truncated = false
    /** Adds a path; false (stop) once a path beyond the cap shows up. */
    const add = (path: string): boolean => {
      if (path === '' || deleted.has(path) || seen.has(path)) return true
      if (seen.size >= max) {
        truncated = true
        return false
      }
      seen.add(path)
      return true
    }
    // Tracked: `<mode> <object> <stage>\t<path>`. Gitlinks (submodules) are folders, not files.
    await gitStream(root, ['ls-files', '-z', '--stage', '--cached'], (entry) => {
      const tab = entry.indexOf('\t')
      return tab === -1 || entry.startsWith(GITLINK_MODE + ' ') || add(entry.slice(tab + 1))
    })
    if (!truncated) {
      // Untracked: a nested repository is listed as its folder, with a trailing slash.
      await gitStream(
        root,
        ['ls-files', '-z', '--others', '--exclude-standard'],
        (path) => path.endsWith('/') || add(path),
      )
    }
    return { paths: [...seen].sort(), truncated }
  }

  async readFile(root: string, relPath: string): Promise<FileContent> {
    const p = await safePath(root, relPath)
    if (p.missing) return { kind: 'missing' }
    const s = await stat(p.abs)
    if (s.isDirectory()) {
      if ((await lstat(p.lexical)).isSymbolicLink()) return { kind: 'symlinkToFolder' }
      throw new Error('Path is a directory')
    }
    if (!s.isFile()) throw new Error('Not a regular file')
    const head = await readHead(p.abs, Math.min(s.size, MAX_TEXT_BYTES))
    if (looksBinary(head)) return { kind: 'binary', size: s.size }
    const truncated = s.size > MAX_TEXT_BYTES
    // stream: true holds back a multi-byte character cut in half at the limit instead of emitting U+FFFD.
    const content = new TextDecoder('utf-8').decode(head, { stream: truncated })
    return { kind: 'text', content, size: s.size, truncated }
  }

  async readImage(root: string, relPath: string): Promise<string | null> {
    const mime = IMAGE_MIME[extname(relPath).toLowerCase()]
    if (!mime) return null
    try {
      const p = await safePath(root, relPath)
      if (p.missing) return null
      const s = await stat(p.abs)
      if (!s.isFile() || s.size > MAX_IMAGE_BYTES) return null
      const data = await readHead(p.abs, s.size)
      return `data:${mime};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  async searchFiles(
    root: string,
    isRepo: boolean,
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const q = checkSearchQuery(query)
    const opts = normalizeSearchOptions(options)
    if (signal?.aborted) throw new SearchCancelledError()
    const deadline = Date.now() + this.searchTimeoutMs
    return isRepo ? this.grepRepo(root, q, opts, deadline, signal) : this.searchFolder(root, q, opts, deadline, signal)
  }

  /**
   * `git grep` over tracked and untracked, not ignored files, stopped once past the cap. A regular expression is
   * Perl-compatible (`-P`), the closest to the JavaScript a folder search uses, and must compile in JavaScript too,
   * so both kinds of search read it alike and report the same errors. A git built without PCRE falls back to POSIX
   * extended syntax (`-E`), noted in the result.
   */
  private async grepRepo(
    root: string,
    query: string,
    opts: Required<SearchOptions>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    // Throws "Invalid regular expression: …" before git runs; for a literal search it always compiles.
    const pattern = searchPattern(query, opts)
    let dialect: GrepDialect = !opts.regex ? '-F' : this.perlRegex === false ? '-E' : '-P'
    let grep: GrepOutput
    try {
      try {
        grep = await this.runGrep(root, query, opts, dialect, deadline, signal)
      } catch (err) {
        if (dialect !== '-P' || !(err instanceof CommandError) || !isNoPcreError(err.stderr)) throw err
        this.perlRegex = false // looked up once: this git has no PCRE
        dialect = '-E'
        grep = await this.runGrep(root, query, opts, dialect, deadline, signal)
      }
    } catch (err) {
      if (signal?.aborted) throw new SearchCancelledError() // git was killed
      if (err instanceof CommandError && err.timedOut) throw new SearchTimeoutError(this.searchTimeoutMs)
      throw grepError(err, query)
    }
    if (dialect === '-P') this.perlRegex = true
    const { found, truncated } = grep
    // git only reports where a line's match starts; find its length (and so the highlight) in JavaScript.
    // A match JavaScript reads differently just isn't highlighted.
    let hits: LineHit[][] = found.map(() => [])
    if (found.length > 0) {
      const matcher = new LineMatcher(pattern, deadline, this.searchTimeoutMs)
      try {
        hits = await matcher.match(
          found.map((f) => f.text),
          found.length,
          signal,
        )
      } catch (err) {
        // git has found them already: show them where git says, just without the highlight's length.
        if (!(err instanceof SearchTimeoutError)) throw err
      } finally {
        matcher.close()
      }
    }
    const matches = found.map((f, i): SearchMatch => {
      const start = Buffer.from(f.text, 'utf8')
        .subarray(0, f.byteColumn - 1)
        .toString('utf8').length
      const hit = hits[i]?.[0]
      const match = makeMatch(f.path, f.line, f.text, hit ? hit[1] : start, hit ? hit[2] : 0)
      return { ...match, column: start + 1 }
    })
    return dialect === '-E' ? { matches, truncated, note: NO_PCRE_NOTE } : { matches, truncated }
  }

  /**
   * Runs the grep and collects its matching lines. git prints `path\0line\0column\0text\n` per matching line:
   * only the first three NULs of a record separate fields, and the text runs to its first newline (it may hold NUL
   * bytes itself: git's binary check only looks at a file's start). Rejects with git's CommandError.
   */
  private async runGrep(
    root: string,
    query: string,
    opts: Required<SearchOptions>,
    dialect: GrepDialect,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<GrepOutput> {
    const args = [
      'grep',
      '-n',
      '--column',
      '-I',
      '--no-color',
      '-z',
      dialect,
      ...(opts.caseSensitive ? [] : ['-i']),
      '--untracked',
      '--exclude-standard',
      // submodule.recurse=true in the user's config turns on --recurse-submodules, which git refuses with --untracked.
      '--no-recurse-submodules',
      '-e',
      query,
      '--',
    ]
    const found: GrepLine[] = []
    let truncated = false
    let field = 0
    let path = ''
    let line = 0
    let byteColumn = 0
    /** The text read so far, up to a NUL inside it. */
    let text = ''
    const onItem = (item: string): boolean => {
      switch (field) {
        case 0:
          path = item
          field = 1
          return true
        case 1:
          line = Number(item)
          field = 2
          return true
        case 2:
          byteColumn = Number(item)
          field = 3
          return true
      }
      const nl = item.indexOf('\n')
      if (nl === -1) {
        // A NUL inside the line (git ends every line with a newline, even the last): the text goes on.
        text += `${item}\0`
        return true
      }
      text += item.slice(0, nl)
      if (!Number.isInteger(line) || line < 1 || !Number.isInteger(byteColumn) || byteColumn < 1) {
        truncated = true // not a line number and column: stop rather than misread the rest
        return false
      }
      if (found.length >= MAX_SEARCH_MATCHES) {
        truncated = true
        return false
      }
      found.push({ path, line, byteColumn, text })
      text = ''
      path = item.slice(nl + 1)
      field = 1
      return true
    }
    await streamNul('git', gitArgs(root, args), onItem, {
      env: GIT_ENV,
      timeoutMs: Math.max(1, deadline - Date.now()),
      okExitCodes: [1], // no matches
      signal,
    })
    return { found, truncated }
  }

  /** The listFiles walk, binary files skipped, matched in a worker (see LineMatcher). */
  private async searchFolder(
    root: string,
    query: string,
    opts: Required<SearchOptions>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const pattern = searchPattern(query, opts) // throws for an invalid regular expression
    const { paths, truncated: walkTruncated } = await walk(root, this.maxWalkEntries)
    const matches: SearchMatch[] = []
    let truncated = false
    const matcher = new LineMatcher(pattern, deadline, this.searchTimeoutMs)
    try {
      for (let i = 0; i < paths.length && !truncated; i += SEARCH_BATCH) {
        if (signal?.aborted) throw new SearchCancelledError()
        if (Date.now() >= deadline) throw new SearchTimeoutError(this.searchTimeoutMs)
        const batch = paths.slice(i, i + SEARCH_BATCH)
        const texts = await Promise.all(batch.map((rel) => searchableText(root, rel)))
        const present = batch.flatMap((rel, j) => (texts[j] === null ? [] : [{ rel, text: texts[j] as string }]))
        // One more than still fits, to know whether the cap cut anything off.
        const hits = await matcher.match(
          present.map((p) => p.text),
          MAX_SEARCH_MATCHES - matches.length + 1,
          signal,
        )
        present.forEach(({ rel, text }, j) => {
          if (hits[j].length === 0 || truncated) return
          const lines = text.split('\n')
          for (const [line, start, length] of hits[j]) {
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true
              return
            }
            matches.push(makeMatch(rel, line, lines[line - 1] ?? '', start, length))
          }
        })
      }
    } finally {
      matcher.close()
    }
    return { matches, truncated: truncated || walkTruncated }
  }

  async listChanges(worktree: string, baseRef: string): Promise<ChangeList> {
    const { base, fallback } = await this.resolveBase(worktree, baseRef)
    const [nameStatus, numstat, others] = await Promise.all([
      git(worktree, ['diff', ...DIFF_FLAGS, '-z', '-M', '--name-status', base, '--']),
      git(worktree, ['diff', ...DIFF_FLAGS, '-z', '-M', '--numstat', base, '--']),
      git(worktree, ['ls-files', '-z', '--others', '--exclude-standard']),
    ])
    const counts = parseNumstat(numstat)
    const byPath = new Map<string, ChangedFile>()
    for (const ns of parseNameStatus(nameStatus)) {
      const c = counts.get(ns.path) ?? { added: 0, removed: 0, binary: false }
      byPath.set(ns.path, { ...ns, ...c })
    }
    const othersSet = new Set(splitZ(others))
    // A file removed from the index but kept on disk (`git rm --cached`) is a deletion, not an untracked file.
    const deletions = [...byPath.values()].filter((f) => f.status === 'D')
    for (let i = 0; i < deletions.length; i += LSTAT_BATCH) {
      const batch = deletions.slice(i, i + LSTAT_BATCH)
      const onDisk = await Promise.all(
        batch.map(
          (f) =>
            othersSet.has(f.path) ||
            lstat(join(worktree, f.path)).then(
              (s) => s.isFile() || s.isSymbolicLink(),
              () => false,
            ),
        ),
      )
      batch.forEach((f, j) => {
        if (onDisk[j]) f.existsOnDisk = true
      })
    }
    const untracked = [...othersSet].filter((path) => !byPath.has(path))
    for (let i = 0; i < untracked.length; i += LSTAT_BATCH) {
      const batch = untracked.slice(i, i + LSTAT_BATCH)
      const entries = await Promise.all(batch.map((path) => this.untrackedEntry(worktree, path)))
      for (const entry of entries) if (entry) byPath.set(entry.path, entry)
    }
    const files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return fallback ? { files, fallback } : { files }
  }

  async fileDiff(worktree: string, baseRef: string, relPath: string, oldPath?: string): Promise<string> {
    const p = await safePath(worktree, relPath)
    const rel = p.rel
    // git diffs a symlink as a file holding its target, so only a real directory is refused.
    const link = !p.missing && (await lstat(p.lexical)).isSymbolicLink()
    const toFolder = !p.missing && (await stat(p.abs)).isDirectory()
    if (toFolder && !link) throw new Error('Path is a directory')
    if (oldPath !== undefined) {
      // A rename from the change list: diff the pair directly instead of looking the rename up again.
      const old = await safePath(worktree, oldPath)
      const { base } = await this.resolveBase(worktree, baseRef)
      return git(worktree, ['diff', ...DIFF_FLAGS, '-M', base, '--', old.rel, rel])
    }
    if (!p.missing && !(await this.isTracked(worktree, rel))) {
      // Untracked, unless it was removed from git but kept on disk: listChanges reports that as a deletion.
      const { base } = await this.resolveBase(worktree, baseRef)
      const own = await git(worktree, ['diff', ...DIFF_FLAGS, '-z', '--name-status', base, '--', rel])
      if (parseNameStatus(own).some((ns) => ns.path === rel && ns.status === 'D')) {
        return git(worktree, ['diff', ...DIFF_FLAGS, base, '--', rel])
      }
      // --no-index follows a symlink to a folder (and prints nothing), so write git's diff for it here.
      if (toFolder) return newSymlinkDiff(rel, await readlink(p.lexical))
      return git(worktree, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', rel], [1])
    }
    const { base } = await this.resolveBase(worktree, baseRef)
    // A path the base has is no rename's new name: diff it as is, without looking renames up in the whole tree
    // (on every poll of the open diff).
    if (await this.inCommit(worktree, base, rel)) return git(worktree, ['diff', ...DIFF_FLAGS, '-M', base, '--', rel])
    const nameStatus = await git(worktree, ['diff', ...DIFF_FLAGS, '-z', '-M', '--name-status', base, '--'])
    const rename = parseNameStatus(nameStatus).find((ns) => ns.path === rel && ns.oldPath !== undefined)
    const paths = rename?.oldPath ? [rename.oldPath, rel] : [rel]
    return git(worktree, ['diff', ...DIFF_FLAGS, '-M', base, '--', ...paths])
  }

  /** The merge-base of HEAD and baseRef, or HEAD (uncommitted changes only) when baseRef can't be resolved. */
  private async resolveBase(
    worktree: string,
    baseRef: string,
  ): Promise<{ base: string; fallback?: 'uncommitted-only' }> {
    if (baseRef && !baseRef.startsWith('-')) {
      try {
        // The full ref: a tag or local branch named like the base (`origin/main`) must not take its place.
        const ref = await resolveBaseRef(baseRef, (full) =>
          git(worktree, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`]).then(
            () => true,
            () => false,
          ),
        )
        const sha = (await git(worktree, ['merge-base', 'HEAD', ref])).trim()
        if (/^[0-9a-f]{40,64}$/.test(sha)) return { base: sha }
      } catch {
        // missing ref or no common history: fall through
      }
    }
    return { base: 'HEAD', fallback: 'uncommitted-only' }
  }

  /** Whether commit `rev` has a file (or symlink, or submodule) at `rel`. */
  private async inCommit(worktree: string, rev: string, rel: string): Promise<boolean> {
    try {
      await git(worktree, ['cat-file', '-e', `${rev}:${rel}`])
      return true
    } catch {
      return false
    }
  }

  private async isTracked(worktree: string, rel: string): Promise<boolean> {
    try {
      await git(worktree, ['ls-files', '--error-unmatch', '--', rel])
      return true
    } catch {
      return false
    }
  }

  /** Line count and binary flag of an untracked file, cached by size and mtime (LRU, bounded). */
  private async untrackedStats(abs: string, key: string, s: Stats): Promise<UntrackedStats> {
    const hit = this.untrackedCache.get(key)
    this.untrackedCache.delete(key) // re-inserted below as the most recently used
    let value = hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs ? hit : undefined
    if (!value) {
      const counted = s.size <= MAX_COUNT_BYTES
      const head = await readHead(abs, counted ? s.size : BINARY_SNIFF_BYTES)
      const binary = looksBinary(head)
      value = { size: s.size, mtimeMs: s.mtimeMs, binary, added: counted && !binary ? countLines(head) : 0 }
    }
    this.untrackedCache.set(key, value)
    if (this.untrackedCache.size > UNTRACKED_CACHE_MAX) {
      this.untrackedCache.delete(this.untrackedCache.keys().next().value as string)
    }
    return value
  }

  /** A change-list entry for an untracked file or symlink; null for anything else (e.g. a nested repo's folder). */
  private async untrackedEntry(worktree: string, path: string): Promise<ChangedFile | null> {
    const entry: ChangedFile = { path, status: 'U', added: 0, removed: 0, binary: false }
    const abs = join(worktree, path)
    let s
    try {
      s = await lstat(abs)
    } catch {
      return null // vanished since ls-files
    }
    if (!s.isFile() && !s.isSymbolicLink()) return null
    try {
      if (s.isSymbolicLink()) {
        // git diffs a symlink as its target text; never follow it.
        entry.added = (await readlink(abs)) === '' ? 0 : 1
        return entry
      }
      const stats = await this.untrackedStats(abs, `${worktree}\0${path}`, s)
      entry.added = stats.added
      entry.binary = stats.binary
    } catch {
      // unreadable: report it with zero counts
    }
    return entry
  }
}
