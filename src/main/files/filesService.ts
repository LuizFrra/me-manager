import type { Stats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangedFile, ChangeList, ChangeStatus, FileContent } from '../../shared/types'
import type { FilesApi } from '../contracts'
import { run } from '../exec'

export const MAX_TEXT_BYTES = 1_000_000
export const BINARY_SNIFF_BYTES = 8_192
export const MAX_IMAGE_BYTES = 5_000_000
export const MAX_WALK_ENTRIES = 20_000
/** Untracked files up to this size get a line count in the change list; larger ones report `added: 0`. */
export const MAX_COUNT_BYTES = 256 * 1024
/** Untracked-file stats remembered between polls. */
const UNTRACKED_CACHE_MAX = 5_000

const OUTSIDE = 'Path is outside the folder'
const GIT_TIMEOUT_MS = 30_000
const LSTAT_BATCH = 256

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/**
 * Git variables that would redirect git to another repository (they are set inside git hooks and
 * some terminals). Setting them to undefined removes them from the child's environment.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_PREFIX: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_EXTERNAL_DIFF: undefined,
}

/** Flags that pin diff output to the plain format the renderer parses, whatever the user's git config says. */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

function git(cwd: string, args: string[], okExitCodes?: number[]): Promise<string> {
  return run('git', ['-C', cwd, '-c', 'core.quotepath=false', '--literal-pathspecs', ...args], {
    env: GIT_ENV,
    timeoutMs: GIT_TIMEOUT_MS,
    okExitCodes,
  })
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s !== '')
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

export type SafePath = { abs: string; rel: string; missing?: undefined } | { missing: true; abs: string; rel: string }

/**
 * Resolves `rel` inside `root`, refusing anything that escapes it lexically or through a symlink.
 * `rel` in the result is normalized and POSIX-separated, suitable as a git pathspec.
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
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true, abs: candidate, rel: normRel }
    throw err
  }
  if (!inside(real)) throw new Error(OUTSIDE)
  return { abs: real, rel: normRel }
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

async function keepFilesAndLinks(root: string, paths: string[]): Promise<string[]> {
  const kept: string[] = []
  for (let i = 0; i < paths.length; i += LSTAT_BATCH) {
    const batch = paths.slice(i, i + LSTAT_BATCH)
    const stats = await Promise.all(batch.map((p) => lstat(join(root, p)).catch(() => null)))
    batch.forEach((p, j) => {
      const s = stats[j]
      if (s && (s.isFile() || s.isSymbolicLink())) kept.push(p)
    })
  }
  return kept
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = ['']
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES) {
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
        out.push(rel)
        if (out.length >= MAX_WALK_ENTRIES) break
      }
    }
  }
  return out.sort()
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
export class FilesService implements FilesApi {
  /** Untracked-file stats by `worktree\0path`, so polls don't re-read unchanged files. Insertion order = LRU order. */
  private readonly untrackedCache = new Map<string, UntrackedStats>()

  async listFiles(root: string, isRepo: boolean): Promise<string[]> {
    if (!isRepo) return walk(root)
    const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    const unique = [...new Set(splitZ(out))]
    return (await keepFilesAndLinks(root, unique)).sort()
  }

  async readFile(root: string, relPath: string): Promise<FileContent> {
    const p = await safePath(root, relPath)
    if (p.missing) return { kind: 'missing' }
    const s = await stat(p.abs)
    if (s.isDirectory()) throw new Error('Path is a directory')
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
    const untracked = [...new Set(splitZ(others))].filter((path) => !byPath.has(path))
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
    if (!p.missing && (await stat(p.abs)).isDirectory()) throw new Error('Path is a directory')
    if (oldPath !== undefined) {
      // A rename from the change list: diff the pair directly instead of looking the rename up again.
      const old = await safePath(worktree, oldPath)
      const { base } = await this.resolveBase(worktree, baseRef)
      return git(worktree, ['diff', ...DIFF_FLAGS, '-M', base, '--', old.rel, rel])
    }
    if (!p.missing && !(await this.isTracked(worktree, rel))) {
      return git(worktree, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', rel], [1])
    }
    const { base } = await this.resolveBase(worktree, baseRef)
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
        const sha = (await git(worktree, ['merge-base', 'HEAD', baseRef])).trim()
        if (/^[0-9a-f]{40,64}$/.test(sha)) return { base: sha }
      } catch {
        // missing ref or no common history: fall through
      }
    }
    return { base: 'HEAD', fallback: 'uncommitted-only' }
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
