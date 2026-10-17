import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../exec'

// Tests may run inside a git worktree or hook where these point at the outer repo.
// run() passes process.env through, so clear them for the whole test process.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
  delete process.env[key]
}

/** git with a fixed identity and no signing/hooks, so commits work on any machine. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return run('git', [
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
  ])
}

export async function commitFile(repo: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(repo, file), content)
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', message)
}

/** A bare "origin", plus a clone of it with one commit on main. */
export async function makeClonedRepo(): Promise<{ root: string; clone: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mm-git-')))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const clone = join(root, 'clone')
  await run('git', ['init', '--bare', '-b', 'main', origin])
  await mkdir(seed)
  await run('git', ['init', '-b', 'main', seed])
  await commitFile(seed, 'README.md', 'hello\n', 'init')
  await git(seed, 'remote', 'add', 'origin', origin)
  await git(seed, 'push', 'origin', 'main')
  await run('git', ['clone', origin, clone])
  return { root, clone }
}

/** A repo with no remotes and one commit on main. */
export async function makeLocalRepo(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mm-git-')))
  const repo = join(root, 'local')
  await mkdir(repo)
  await run('git', ['init', '-b', 'main', repo])
  await commitFile(repo, 'README.md', 'hello\n', 'init')
  return { root, repo }
}
