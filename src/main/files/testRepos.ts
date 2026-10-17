import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run } from '../exec'

/** Variables that would point git at another repo (set inside hooks or worktrees). Cleared for every helper call. */
const CLEAN_ENV: NodeJS.ProcessEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_PREFIX: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

const created: string[] = []

/** A fresh temp dir, resolved through symlinks (macOS tmpdir is one). Removed by cleanupTempDirs(). */
export async function makeTempDir(prefix = 'mm-files-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}

export async function cleanupTempDirs(): Promise<void> {
  const dirs = created.splice(0)
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
}

/** git with a fixed identity, no signing/hooks and no user/system config, so it behaves the same on any machine. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return run(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { env: CLEAN_ENV },
  )
}

/** Writes a file (creating parent dirs) relative to root. */
export async function put(root: string, rel: string, content: string | Uint8Array): Promise<void> {
  const abs = join(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', message)
}

/** A repo with no remotes, seeded with `files` in one commit on main. */
export async function makeRepo(files: Record<string, string | Uint8Array>): Promise<string> {
  const repo = join(await makeTempDir(), 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  for (const [rel, content] of Object.entries(files)) await put(repo, rel, content)
  await commitAll(repo, 'init')
  return repo
}

/**
 * A bare origin seeded with `files` on main, a seed checkout that can push more upstream commits,
 * and a clone of origin checked out on a new `task` branch (like a task worktree with baseRef origin/main).
 */
export async function makeTaskClone(
  files: Record<string, string | Uint8Array>,
): Promise<{ origin: string; seed: string; clone: string }> {
  const root = await makeTempDir()
  const origin = join(root, 'origin.git')
  const clone = join(root, 'clone')
  const seed = join(root, 'seed')
  await mkdir(seed)
  await git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  await git(seed, 'init', '-q', '-b', 'main')
  for (const [rel, content] of Object.entries(files)) await put(seed, rel, content)
  await commitAll(seed, 'init')
  await git(seed, 'remote', 'add', 'origin', origin)
  await git(seed, 'push', '-q', 'origin', 'main')
  await git(root, 'clone', '-q', origin, clone)
  await git(clone, 'checkout', '-q', '-b', 'task', 'origin/main')
  return { origin, seed, clone }
}
