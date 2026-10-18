import { mkdir, rm, symlink, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as exec from '../exec'
import {
  FilesService,
  MAX_COUNT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REPO_ENTRIES,
  MAX_TEXT_BYTES,
  safePath,
} from './filesService'
import { cleanupTempDirs, commitAll, git, makeRepo, makeTaskClone, makeTempDir, put } from './testRepos'

const svc = new FilesService()

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

// Wraps the real `run` in a spy, so tests can check which git commands a call makes.
vi.mock('../exec', async (importOriginal) => {
  const real = await importOriginal<typeof import('../exec')>()
  return { ...real, run: vi.fn(real.run) }
})
const runSpy = vi.mocked(exec.run)
/** The git subcommands (and flags) run since the last reset, one string per call. */
const gitCalls = (): string[] =>
  runSpy.mock.calls
    .filter(([file]) => file === 'git')
    .map(([, args]) => args.slice(args.indexOf('--literal-pathspecs') + 1).join(' '))

beforeEach(() => {
  runSpy.mockClear()
})
afterEach(cleanupTempDirs)

describe('safePath', () => {
  it('rejects empty, absolute, NUL and parent-escaping paths', async () => {
    const root = await makeTempDir()
    for (const rel of ['', '/etc/passwd', '../x', 'a/../../x', 'a\0b']) {
      await expect(safePath(root, rel), JSON.stringify(rel)).rejects.toThrow('Path is outside the folder')
    }
  })

  it('resolves a file inside the root to its realpath', async () => {
    const root = await makeTempDir()
    await put(root, 'sub/a.txt', 'a')
    await expect(safePath(root, 'sub/../sub/a.txt')).resolves.toMatchObject({ abs: join(root, 'sub/a.txt') })
  })

  it('works when the root itself is reached through a symlink', async () => {
    const real = await makeTempDir()
    const holder = await makeTempDir()
    await put(real, 'a.txt', 'a')
    await symlink(real, join(holder, 'link'))
    await expect(safePath(join(holder, 'link'), 'a.txt')).resolves.toMatchObject({ abs: join(real, 'a.txt') })
  })

  it('throws for a symlink that points outside the root', async () => {
    const root = await makeTempDir()
    const outside = await makeTempDir()
    await put(outside, 'secret.txt', 'secret')
    await symlink('/etc', join(root, 'etc'))
    await symlink(join(outside, 'secret.txt'), join(root, 'secret.txt'))
    await expect(safePath(root, 'etc')).rejects.toThrow('Path is outside the folder')
    await expect(safePath(root, 'etc/hostname')).rejects.toThrow('Path is outside the folder')
    await expect(safePath(root, 'secret.txt')).rejects.toThrow('Path is outside the folder')
  })

  it('throws for a sibling dir that shares the root as a name prefix', async () => {
    const parent = await makeTempDir()
    await mkdir(join(parent, 'root'))
    await put(parent, 'root-evil/x.txt', 'x')
    await symlink(join(parent, 'root-evil/x.txt'), join(parent, 'root/x.txt'))
    await expect(safePath(join(parent, 'root'), '../root-evil/x.txt')).rejects.toThrow('Path is outside the folder')
    await expect(safePath(join(parent, 'root'), 'x.txt')).rejects.toThrow('Path is outside the folder')
  })

  it('allows a symlink to a file inside the root', async () => {
    const root = await makeTempDir()
    await put(root, 'real/target.txt', 't')
    await symlink('real/target.txt', join(root, 'link.txt'))
    await expect(safePath(root, 'link.txt')).resolves.toMatchObject({ abs: join(root, 'real/target.txt') })
  })

  it('returns missing for a file that does not exist (or sits under a file)', async () => {
    const root = await makeTempDir()
    await put(root, 'a.txt', 'a')
    await expect(safePath(root, 'nope.txt')).resolves.toMatchObject({ missing: true })
    await expect(safePath(root, 'a.txt/child')).resolves.toMatchObject({ missing: true })
  })

  it('treats a dangling symlink as missing only if it points inside', async () => {
    const root = await makeTempDir()
    await symlink(join(root, 'gone.txt'), join(root, 'dangling-in'))
    await expect(safePath(root, 'dangling-in')).resolves.toMatchObject({ missing: true })
  })
})

describe('listFiles (repo)', () => {
  it('lists tracked and untracked files, but not ignored ones', async () => {
    const repo = await makeRepo({ 'README.md': 'hi\n', '.gitignore': 'ignored.log\nbuild/\n', 'src/a.ts': 'a\n' })
    await put(repo, 'untracked.txt', 'u')
    await put(repo, 'ignored.log', 'i')
    await put(repo, 'build/out.js', 'o')
    await put(repo, 'ação *.txt', 'unicode')
    await expect(svc.listFiles(repo, true)).resolves.toEqual({
      paths: ['.gitignore', 'README.md', 'ação *.txt', 'src/a.ts', 'untracked.txt'],
      truncated: false,
    })
  })

  it('drops tracked-but-deleted files and keeps symlinks', async () => {
    const repo = await makeRepo({ 'keep.txt': 'k', 'gone.txt': 'g' })
    await unlink(join(repo, 'gone.txt'))
    await symlink('keep.txt', join(repo, 'link.txt'))
    await expect(svc.listFiles(repo, true)).resolves.toEqual({ paths: ['keep.txt', 'link.txt'], truncated: false })
  })

  it('drops nested repositories (directories) reported by ls-files', async () => {
    const repo = await makeRepo({ 'a.txt': 'a' })
    await mkdir(join(repo, 'nested'))
    await git(join(repo, 'nested'), 'init', '-q')
    await put(repo, 'nested/inner.txt', 'n')
    await expect(svc.listFiles(repo, true)).resolves.toEqual({ paths: ['a.txt'], truncated: false })
  })

  it('drops tracked submodules (gitlinks)', async () => {
    const repo = await makeRepo({ 'a.txt': 'a' })
    const sub = join(repo, 'sub')
    await mkdir(sub)
    await git(sub, 'init', '-q', '-b', 'main')
    await put(sub, 's.txt', 's')
    await commitAll(sub, 'sub')
    await git(repo, 'add', 'sub')
    await expect(svc.listFiles(repo, true)).resolves.toEqual({ paths: ['a.txt'], truncated: false })
  })

  it('drops files deleted from the work tree but still staged, without stat-ing every path', async () => {
    const repo = await makeRepo({ 'keep.txt': 'k' })
    await put(repo, 'staged.txt', 's')
    await git(repo, 'add', 'staged.txt')
    await unlink(join(repo, 'staged.txt'))
    await expect(svc.listFiles(repo, true)).resolves.toEqual({ paths: ['keep.txt'], truncated: false })
  })

  it('stops at maxRepoEntries and reports truncation', async () => {
    const repo = await makeRepo({ 'a.txt': 'a', 'b.txt': 'b' })
    await put(repo, 'c.txt', 'c')
    await put(repo, 'd.txt', 'd')
    const capped = new FilesService({ maxRepoEntries: 3 })
    const res = await capped.listFiles(repo, true)
    expect(res.truncated).toBe(true)
    expect(res.paths).toHaveLength(3)
    expect(res.paths).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
    await expect(new FilesService({ maxRepoEntries: 4 }).listFiles(repo, true)).resolves.toEqual({
      paths: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
      truncated: false,
    })
  })

  it('defaults to a cap of MAX_REPO_ENTRIES', () => {
    expect(MAX_REPO_ENTRIES).toBe(50_000)
  })

  it('ignores GIT_DIR / GIT_WORK_TREE from the environment', async () => {
    const repo = await makeRepo({ 'a.txt': 'a' })
    const other = await makeRepo({ 'other.txt': 'o' })
    const saved = { dir: process.env.GIT_DIR, wt: process.env.GIT_WORK_TREE }
    process.env.GIT_DIR = join(other, '.git')
    process.env.GIT_WORK_TREE = other
    try {
      await expect(svc.listFiles(repo, true)).resolves.toEqual({ paths: ['a.txt'], truncated: false })
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.dir
      if (saved.wt === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = saved.wt
    }
  })
})

describe('listFiles (folder)', () => {
  it('walks the folder, skipping .git and node_modules, with POSIX paths, sorted', async () => {
    const root = await makeTempDir()
    await put(root, 'b.txt', 'b')
    await put(root, 'a/deep/c.txt', 'c')
    await put(root, '.git/config', 'x')
    await put(root, 'node_modules/pkg/index.js', 'x')
    await put(root, 'sub/node_modules/pkg/index.js', 'x')
    await put(root, '.env', 'x')
    await expect(svc.listFiles(root, false)).resolves.toEqual({
      paths: ['.env', 'a/deep/c.txt', 'b.txt'],
      truncated: false,
    })
  })

  it('stops at maxWalkEntries and reports truncation', async () => {
    const root = await makeTempDir()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await put(root, name, name)
    const res = await new FilesService({ maxWalkEntries: 2 }).listFiles(root, false)
    expect(res).toEqual({ paths: expect.any(Array), truncated: true })
    expect(res.paths).toHaveLength(2)
    await expect(new FilesService({ maxWalkEntries: 3 }).listFiles(root, false)).resolves.toEqual({
      paths: ['a.txt', 'b.txt', 'c.txt'],
      truncated: false,
    })
  })

  it('lists symlinks as entries but does not follow symlinked directories', async () => {
    const root = await makeTempDir()
    const outside = await makeTempDir()
    await put(outside, 'secret.txt', 's')
    await put(root, 'a.txt', 'a')
    await symlink(outside, join(root, 'outdir'))
    await symlink(root, join(root, 'loop'))
    await expect(svc.listFiles(root, false)).resolves.toEqual({ paths: ['a.txt', 'loop', 'outdir'], truncated: false })
  })
})

describe('readFile', () => {
  it('reads a text file', async () => {
    const root = await makeTempDir()
    await put(root, 'a.txt', 'héllo\n')
    await expect(svc.readFile(root, 'a.txt')).resolves.toEqual({
      kind: 'text',
      content: 'héllo\n',
      size: 7,
      truncated: false,
    })
  })

  it('reports binary for a NUL byte in the first 8 KB', async () => {
    const root = await makeTempDir()
    await put(root, 'img.png', PNG)
    await expect(svc.readFile(root, 'img.png')).resolves.toEqual({ kind: 'binary', size: PNG.length })
  })

  it('truncates a large file without splitting a multi-byte character', async () => {
    const root = await makeTempDir()
    // 'é' is 2 bytes; an odd prefix puts a character across the 1 MB cut.
    const content = 'x' + 'é'.repeat(750_000)
    await put(root, 'big.txt', content)
    const res = await svc.readFile(root, 'big.txt')
    expect(res.kind).toBe('text')
    if (res.kind !== 'text') return
    expect(res.size).toBe(1_500_001)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.content)).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    expect(res.content).toBe(content.slice(0, res.content.length))
    expect(res.content).not.toContain('�')
    expect(res.content.length).toBe(500_000)
  })

  it('returns missing for a file that does not exist', async () => {
    const root = await makeTempDir()
    await expect(svc.readFile(root, 'nope.txt')).resolves.toEqual({ kind: 'missing' })
  })

  it('throws for a directory and for escaping paths', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'dir'))
    await symlink('/etc/hostname', join(root, 'host'))
    await expect(svc.readFile(root, 'dir')).rejects.toThrow(/directory/)
    await expect(svc.readFile(root, '../x')).rejects.toThrow('Path is outside the folder')
    await expect(svc.readFile(root, 'host')).rejects.toThrow('Path is outside the folder')
  })
})

describe('readImage', () => {
  it('returns a data URL for a png', async () => {
    const root = await makeTempDir()
    await put(root, 'img/logo.PNG', PNG)
    await expect(svc.readImage(root, 'img/logo.PNG')).resolves.toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    )
  })

  it('uses image/svg+xml for svg', async () => {
    const root = await makeTempDir()
    await put(root, 'a.svg', '<svg/>')
    await expect(svc.readImage(root, 'a.svg')).resolves.toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    )
  })

  it('returns null for non-images, missing files, escapes and oversized files', async () => {
    const root = await makeTempDir()
    const outside = await makeTempDir()
    await put(root, 'a.txt', 'a')
    await put(outside, 'x.png', PNG)
    await symlink(join(outside, 'x.png'), join(root, 'out.png'))
    await put(root, 'huge.png', new Uint8Array(MAX_IMAGE_BYTES + 1))
    await mkdir(join(root, 'dir.png'))
    await expect(svc.readImage(root, 'a.txt')).resolves.toBeNull()
    await expect(svc.readImage(root, 'nope.png')).resolves.toBeNull()
    await expect(svc.readImage(root, '../x.png')).resolves.toBeNull()
    await expect(svc.readImage(root, 'out.png')).resolves.toBeNull()
    await expect(svc.readImage(root, 'huge.png')).resolves.toBeNull()
    await expect(svc.readImage(root, 'dir.png')).resolves.toBeNull()
  })
})

const SEED = {
  'README.md': 'hello\n',
  'mod.txt': 'a\nb\nc\n',
  'del.txt': 'one\ntwo\n',
  'ren.txt': LINES,
  'bin.dat': PNG,
}

describe('listChanges', () => {
  it('returns an empty list for a fresh task', async () => {
    const { clone } = await makeTaskClone(SEED)
    await expect(svc.listChanges(clone, 'origin/main')).resolves.toEqual({ files: [] })
  })

  it('reports committed, uncommitted, untracked, deleted, renamed and binary changes', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'mod.txt', 'a\nB\nc\nd\n')
    await rm(join(clone, 'del.txt'))
    await git(clone, 'mv', 'ren.txt', 'renamed.txt')
    await put(clone, 'bin.dat', Uint8Array.from([...PNG, 1, 2, 3]))
    await commitAll(clone, 'task work')
    await put(clone, 'README.md', 'hello\nworld\n')
    await put(clone, 'new dir/untracked é.txt', 'u1\nu2\nu3')
    await put(clone, 'untracked.bin', PNG)
    await put(clone, '.gitignore', 'ignored.log\n')
    await put(clone, 'ignored.log', 'x')

    const res = await svc.listChanges(clone, 'origin/main')
    expect(res.fallback).toBeUndefined()
    expect(res.files).toEqual([
      { path: '.gitignore', status: 'U', added: 1, removed: 0, binary: false },
      { path: 'README.md', status: 'M', added: 1, removed: 0, binary: false },
      { path: 'bin.dat', status: 'M', added: 0, removed: 0, binary: true },
      { path: 'del.txt', status: 'D', added: 0, removed: 2, binary: false },
      { path: 'mod.txt', status: 'M', added: 2, removed: 1, binary: false },
      { path: 'new dir/untracked é.txt', status: 'U', added: 3, removed: 0, binary: false },
      { path: 'renamed.txt', oldPath: 'ren.txt', status: 'R', added: 0, removed: 0, binary: false },
      { path: 'untracked.bin', status: 'U', added: 0, removed: 0, binary: true },
    ])
  })

  it('reports a staged new file as A and an uncommitted rename with edits as R', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'staged.txt', 's\n')
    await git(clone, 'add', 'staged.txt')
    await mkdir(join(clone, 'moved'))
    await git(clone, 'mv', 'ren.txt', 'moved/ren.txt')
    await put(clone, 'moved/ren.txt', LINES + 'extra\n')
    const res = await svc.listChanges(clone, 'origin/main')
    expect(res.files).toEqual([
      { path: 'moved/ren.txt', oldPath: 'ren.txt', status: 'R', added: 1, removed: 0, binary: false },
      { path: 'staged.txt', status: 'A', added: 1, removed: 0, binary: false },
    ])
  })

  it('compares against the merge-base, ignoring commits that landed upstream later', async () => {
    const { seed, clone } = await makeTaskClone(SEED)
    await put(clone, 'mod.txt', 'task\n')
    await commitAll(clone, 'task')
    await put(seed, 'upstream.txt', 'later\n')
    await put(seed, 'README.md', 'changed upstream\n')
    await commitAll(seed, 'upstream')
    await git(seed, 'push', '-q', 'origin', 'main')
    await git(clone, 'fetch', '-q', 'origin')
    const res = await svc.listChanges(clone, 'origin/main')
    expect(res.files.map((f) => f.path)).toEqual(['mod.txt'])
  })

  it('falls back to uncommitted changes vs HEAD when the base ref is gone', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'mod.txt', 'committed\n')
    await commitAll(clone, 'task')
    await put(clone, 'README.md', 'dirty\n')
    await put(clone, 'new.txt', 'n\n')
    await expect(svc.listChanges(clone, 'origin/gone')).resolves.toEqual({
      fallback: 'uncommitted-only',
      files: [
        { path: 'README.md', status: 'M', added: 1, removed: 1, binary: false },
        { path: 'new.txt', status: 'U', added: 1, removed: 0, binary: false },
      ],
    })
  })

  it('caches untracked line counts by size and mtime', async () => {
    const { clone } = await makeTaskClone(SEED)
    const local = new FilesService()
    // A whole-second mtime, so restoring it later reproduces the exact same stat (no sub-millisecond part).
    const t = new Date('2024-01-01T00:00:00Z')
    await put(clone, 'new.txt', 'a\nb\n')
    await utimes(join(clone, 'new.txt'), t, t)
    const count = async (): Promise<number | undefined> =>
      (await local.listChanges(clone, 'origin/main')).files.find((f) => f.path === 'new.txt')?.added
    expect(await count()).toBe(2)

    // Same size and mtime: the cached count is reused, so the file is not read again.
    await put(clone, 'new.txt', 'abc\n')
    await utimes(join(clone, 'new.txt'), t, t)
    expect(await count()).toBe(2)

    // A new mtime invalidates the entry.
    await utimes(join(clone, 'new.txt'), t, new Date(t.getTime() + 5_000))
    expect(await count()).toBe(1)
  })

  it('only counts lines of untracked files up to MAX_COUNT_BYTES', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'small.txt', 'x\n'.repeat(MAX_COUNT_BYTES / 2))
    await put(clone, 'large.txt', 'x\n'.repeat(MAX_COUNT_BYTES / 2) + 'y\n')
    await put(clone, 'large.bin', Uint8Array.from([0, ...new Uint8Array(MAX_COUNT_BYTES + 1).fill(65)]))
    const res = await svc.listChanges(clone, 'origin/main')
    expect(res.files).toEqual([
      { path: 'large.bin', status: 'U', added: 0, removed: 0, binary: true },
      { path: 'large.txt', status: 'U', added: 0, removed: 0, binary: false },
      { path: 'small.txt', status: 'U', added: MAX_COUNT_BYTES / 2, removed: 0, binary: false },
    ])
  })

  it('treats an option-like base ref as missing instead of passing it to git', async () => {
    const { clone } = await makeTaskClone(SEED)
    await expect(svc.listChanges(clone, '--output=/tmp/pwned')).resolves.toEqual({
      fallback: 'uncommitted-only',
      files: [],
    })
  })
})

describe('fileDiff', () => {
  it('diffs a modified file (committed and uncommitted edits)', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'mod.txt', 'a\nb\nc\nnew line\n')
    await commitAll(clone, 'task')
    await put(clone, 'mod.txt', 'a\nb\nc\nnew line\ndirty line\n')
    const diff = await svc.fileDiff(clone, 'origin/main', 'mod.txt')
    expect(diff).toContain('--- a/mod.txt')
    expect(diff).toContain('+++ b/mod.txt')
    expect(diff).toContain('@@')
    expect(diff).toContain('+new line')
    expect(diff).toContain('+dirty line')
  })

  it('diffs an untracked file as a new file with every line added', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'sub/fresh *.txt', 'one\ntwo\n')
    const diff = await svc.fileDiff(clone, 'origin/main', 'sub/fresh *.txt')
    expect(diff).toContain('new file mode')
    expect(diff).toContain('+++ b/sub/fresh *.txt')
    const body = diff.split('\n').filter((l) => /^[-+ ]/.test(l) && !/^(---|\+\+\+) /.test(l))
    expect(body).toEqual(['+one', '+two'])
  })

  it('diffs a deleted file with every line removed', async () => {
    const { clone } = await makeTaskClone(SEED)
    await rm(join(clone, 'del.txt'))
    const diff = await svc.fileDiff(clone, 'origin/main', 'del.txt')
    expect(diff).toContain('deleted file mode')
    const body = diff.split('\n').filter((l) => /^[-+ ]/.test(l) && !/^(---|\+\+\+) /.test(l))
    expect(body).toEqual(['-one', '-two'])
  })

  it('shows a rename with rename from / rename to', async () => {
    const { clone } = await makeTaskClone(SEED)
    await git(clone, 'mv', 'ren.txt', 'renamed.txt')
    await commitAll(clone, 'rename')
    const diff = await svc.fileDiff(clone, 'origin/main', 'renamed.txt')
    expect(diff).toContain('rename from ren.txt')
    expect(diff).toContain('rename to renamed.txt')
  })

  it('diffs a rename from the given oldPath without a whole-tree name-status', async () => {
    const { clone } = await makeTaskClone(SEED)
    await git(clone, 'mv', 'ren.txt', 'renamed.txt')
    await put(clone, 'renamed.txt', LINES + 'extra\n')
    runSpy.mockClear()
    const diff = await svc.fileDiff(clone, 'origin/main', 'renamed.txt', 'ren.txt')
    expect(diff).toContain('rename from ren.txt')
    expect(diff).toContain('rename to renamed.txt')
    expect(diff).toContain('+extra')
    expect(gitCalls().filter((c) => c.includes('--name-status'))).toEqual([])
  })

  it('still finds the rename itself when no oldPath is given', async () => {
    const { clone } = await makeTaskClone(SEED)
    await git(clone, 'mv', 'ren.txt', 'renamed.txt')
    const diff = await svc.fileDiff(clone, 'origin/main', 'renamed.txt')
    expect(diff).toContain('rename from ren.txt')
  })

  it('rejects an escaping oldPath', async () => {
    const { clone } = await makeTaskClone(SEED)
    await git(clone, 'mv', 'ren.txt', 'renamed.txt')
    await expect(svc.fileDiff(clone, 'origin/main', 'renamed.txt', '../x')).rejects.toThrow(
      'Path is outside the folder',
    )
    await expect(svc.fileDiff(clone, 'origin/main', 'renamed.txt', '/etc/passwd')).rejects.toThrow(
      'Path is outside the folder',
    )
  })

  it('returns an empty string for an unchanged file', async () => {
    const { clone } = await makeTaskClone(SEED)
    await expect(svc.fileDiff(clone, 'origin/main', 'README.md')).resolves.toBe('')
  })

  it('does not treat glob characters in the path as a pathspec', async () => {
    const { clone } = await makeTaskClone({ ...SEED, 'a1.txt': 'x\n', 'a*.txt': 'y\n' })
    await put(clone, 'a1.txt', 'changed\n')
    await expect(svc.fileDiff(clone, 'origin/main', 'a*.txt')).resolves.toBe('')
  })

  it('uses only uncommitted changes when the base ref is gone', async () => {
    const { clone } = await makeTaskClone(SEED)
    await put(clone, 'mod.txt', 'a\nb\nc\ncommitted\n')
    await commitAll(clone, 'task')
    await put(clone, 'mod.txt', 'a\nb\nc\ncommitted\ndirty\n')
    const diff = await svc.fileDiff(clone, 'origin/gone', 'mod.txt')
    expect(diff).toContain('+dirty')
    expect(diff).not.toContain('+committed')
  })

  it('throws for an escaping path', async () => {
    const { clone } = await makeTaskClone(SEED)
    await symlink('/etc/hostname', join(clone, 'host'))
    await expect(svc.fileDiff(clone, 'origin/main', '../x')).rejects.toThrow('Path is outside the folder')
    await expect(svc.fileDiff(clone, 'origin/main', '/etc/passwd')).rejects.toThrow('Path is outside the folder')
    await expect(svc.fileDiff(clone, 'origin/main', 'host')).rejects.toThrow('Path is outside the folder')
  })
})
