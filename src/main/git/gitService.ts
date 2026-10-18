import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CommitResult, TaskGitStatus, UnsavedWork } from '../../shared/types'
import type { GitApi } from '../contracts'
import { CommandError, run } from '../exec'
import { GIT_ENV } from './gitEnv'

/** A GUI app has no terminal to answer credential prompts, so fail fast instead of hanging. */
const FETCH_TIMEOUT_MS = 30_000
export const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
}
/** `git push` gives up after this long (a hung network, a server that never answers). */
export const PUSH_TIMEOUT_MS = 60_000
/** Commit hooks may run linters or tests; a commit still mustn't hang forever (e.g. a signing prompt). */
const COMMIT_TIMEOUT_MS = 120_000
const MAX_ERROR_SUMMARY = 500

/** `-z` output as its entries, without the trailing empty one. */
const splitZ = (out: string): string[] => out.split('\0').filter(Boolean)

/**
 * git's (or gh's) stderr as one line for a toast: `hint:` lines are dropped and, when there are any, only the
 * `fatal:`/`error:` lines and `! [rejected]` ref lines are kept. `all` keeps every other line too (for messages
 * whose explanation is the point, like a missing identity). Capped at MAX_ERROR_SUMMARY characters.
 */
export function summarizeGitError(stderr: string, all = false): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l))
  const key = lines.filter((l) => /^(fatal|error):|^!\s|^remote: (fatal|error)/i.test(l))
  const text = (all || key.length === 0 ? lines : key).join(' ').replace(/\s+/g, ' ')
  return text.length > MAX_ERROR_SUMMARY ? `${text.slice(0, MAX_ERROR_SUMMARY - 1)}…` : text
}

/** `<what> failed: <git's summary>`, or `<what> timed out after …`, for a failed command. */
export function commandFailure(what: string, err: unknown, all = false): Error {
  if (!(err instanceof CommandError)) return err instanceof Error ? err : new Error(String(err))
  if (err.timedOut)
    return new Error(`${what} ${err.message.slice(err.message.lastIndexOf('timed out'))}`, { cause: err })
  const summary = summarizeGitError(err.stderr, all)
  return new Error(summary ? `${what} failed: ${summary}` : err.message, { cause: err })
}

/** taskStatus is polled; a stuck git (huge repo, network filesystem) must not hold the poll forever. */
const STATUS_TIMEOUT_MS = 10_000

/**
 * Paths from `git status --porcelain -z`: "XY path" entries separated by NUL, never quoted.
 * Renames and copies are followed by an extra entry with the old path, which is skipped.
 */
export function parsePorcelainZ(out: string): string[] {
  const entries = out.split('\0')
  const files: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue // trailing NUL
    files.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) i++
  }
  return files
}

/** `git rev-list --left-right --count <base>...HEAD` prints "<behind>\t<ahead>". */
export function parseLeftRightCount(out: string): { ahead: number; behind: number } | null {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(out)
  return match ? { behind: Number(match[1]), ahead: Number(match[2]) } : null
}

/** `git log -1 --format=%h%x00%s%x00%cr` output; undefined when there is no commit. */
export function parseLastCommit(out: string): TaskGitStatus['lastCommit'] {
  const [sha, subject, relativeDate] = out.replace(/\n$/, '').split('\0')
  return sha && subject !== undefined && relativeDate !== undefined ? { sha, subject, relativeDate } : undefined
}

const ORIGIN_PREFIX = 'refs/remotes/origin/'
const HEADS_PREFIX = 'refs/heads/'

/**
 * `git for-each-ref --format=%(refname)` output for refs/remotes/origin and refs/heads, as base-branch names:
 * `origin/<name>` for origin's branches (but not `origin/HEAD`, which only points at one of them), then the local
 * branch names. Full ref names are read, since git's short names can be ambiguous; a local branch named like one
 * of origin's (`origin/main`) is left out, as the name can only be listed once.
 */
export function parseBranchRefs(out: string): string[] {
  const remote: string[] = []
  const local: string[] = []
  for (const ref of out.split('\n')) {
    if (ref.startsWith(ORIGIN_PREFIX)) {
      const name = ref.slice(ORIGIN_PREFIX.length)
      if (name && name !== 'HEAD') remote.push(`origin/${name}`)
    } else if (ref.startsWith(HEADS_PREFIX) && ref.length > HEADS_PREFIX.length) {
      local.push(ref.slice(HEADS_PREFIX.length))
    }
  }
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const remoteNames = new Set(remote)
  return [...remote.sort(byName), ...local.filter((name) => !remoteNames.has(name)).sort(byName)]
}

export class GitService implements GitApi {
  private git(cwd: string, args: string[]): Promise<string> {
    return run('git', ['-C', cwd, ...args])
  }

  /**
   * Read-only git for status polling, hardened like FilesService: no optional locks (so polling never blocks the
   * user's own git commands on index.lock), no redirecting GIT_* variables, and output pinned against user config.
   */
  private inspect(cwd: string, args: string[]): Promise<string> {
    return run(
      'git',
      ['-C', cwd, '--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'log.showSignature=false', ...args],
      { env: GIT_ENV, timeoutMs: STATUS_TIMEOUT_MS },
    )
  }

  /** git that changes a work tree: no redirecting GIT_* variables, and a timeout when given. */
  private work(
    cwd: string,
    args: string[],
    extra: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<string> {
    return run('git', ['-C', cwd, ...args], { env: { ...GIT_ENV, ...extra.env }, timeoutMs: extra.timeoutMs })
  }

  private async hasOrigin(repoPath: string): Promise<boolean> {
    const out = await this.git(repoPath, ['remote'])
    return out.split('\n').includes('origin')
  }

  private async refExists(repoPath: string, ref: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', '--quiet', ref])
      return true
    } catch {
      return false
    }
  }

  /** False when the repo folder was moved/deleted or is no longer a git repository. */
  private async isRepo(repoPath: string): Promise<boolean> {
    if (!existsSync(repoPath)) return false
    try {
      await this.git(repoPath, ['rev-parse', '--git-dir'])
      return true
    } catch {
      return false
    }
  }

  async repoRoot(path: string): Promise<string | null> {
    try {
      return (await this.git(path, ['rev-parse', '--show-toplevel'])).trim()
    } catch {
      return null
    }
  }

  async fetch(repoPath: string): Promise<void> {
    if (!(await this.hasOrigin(repoPath))) return
    await run('git', ['-C', repoPath, 'fetch', 'origin', '--prune'], {
      timeoutMs: FETCH_TIMEOUT_MS,
      env: NON_INTERACTIVE_ENV,
    })
  }

  async resolveBaseRef(repoPath: string): Promise<string> {
    if (await this.hasOrigin(repoPath)) {
      try {
        const head = (await this.git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
        // origin/HEAD can dangle (e.g. the default branch was renamed and older git kept the link).
        if (head && (await this.refExists(repoPath, `refs/remotes/${head}`))) return head
      } catch {
        // origin/HEAD not set; try well-known names below
      }
      for (const name of ['origin/main', 'origin/master']) {
        if (await this.refExists(repoPath, `refs/remotes/${name}`)) return name
      }
    }
    for (const name of ['main', 'master']) {
      if (await this.refExists(repoPath, `refs/heads/${name}`)) return name
    }
    const current = (await this.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (current && current !== 'HEAD') return current
    throw new Error(`Could not find a base branch in ${repoPath}`)
  }

  async listBranches(repoPath: string): Promise<string[]> {
    const out = await this.inspect(repoPath, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/remotes/origin',
      'refs/heads',
    ])
    return parseBranchRefs(out)
  }

  async verifyRef(repoPath: string, ref: string): Promise<boolean> {
    // A ref starting with '-' would be read as an option.
    if (!ref || ref.startsWith('-')) return false
    try {
      await this.inspect(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void> {
    if (await this.refExists(repoPath, `refs/heads/${branch}`)) {
      throw new Error(
        `Branch "${branch}" already exists (kept from an earlier task). Delete it or choose another task name.`,
      )
    }
    await mkdir(dirname(worktreePath), { recursive: true })
    // --no-track: otherwise the branch would track origin/main and `git push` would be confusing.
    await this.git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseRef])
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (!(await this.isRepo(repoPath))) {
      // Without the original repo git cannot remove it; there is nothing left to prune either.
      await rm(worktreePath, { recursive: true, force: true })
      return
    }
    if (existsSync(worktreePath)) {
      await this.git(repoPath, ['worktree', 'remove', '--force', worktreePath])
    } else {
      await this.git(repoPath, ['worktree', 'prune'])
    }
  }

  async deleteBranch(repoPath: string, branch: string): Promise<void> {
    await this.git(repoPath, ['branch', '-D', branch])
  }

  async getUnsavedWork(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<UnsavedWork> {
    if (!(await this.isRepo(repoPath))) {
      return {
        uncommittedFiles: [],
        unpushedCommits: [],
        warning: `The original repository was not found at ${repoPath}, so uncommitted changes and unpushed commits could not be checked.`,
      }
    }
    let uncommittedFiles: string[] = []
    let warning: string | undefined
    if (existsSync(worktreePath)) {
      try {
        uncommittedFiles = parsePorcelainZ(await this.git(worktreePath, ['status', '--porcelain', '-z']))
      } catch {
        warning = `git status failed in ${worktreePath}, so uncommitted changes in it could not be checked.`
      }
    }
    const withWarning = (work: UnsavedWork): UnsavedWork => (warning ? { ...work, warning } : work)
    if (!(await this.refExists(repoPath, `refs/heads/${branch}`))) {
      return withWarning({ uncommittedFiles, unpushedCommits: [] })
    }
    // Exclude baseRef too: with origin but no fetched refs, --remotes alone would list the whole history.
    // baseRef may have been deleted/pruned since the task was created; then exclude what is still there.
    const hasBase = await this.refExists(repoPath, baseRef)
    const range = (await this.hasOrigin(repoPath))
      ? [branch, '--not', '--remotes', ...(hasBase ? [baseRef] : [])]
      : hasBase
        ? [`${baseRef}..${branch}`]
        : [branch, '--not', `--exclude=${branch}`, '--branches']
    const log = await this.git(repoPath, ['log', '--format=%h %s', ...range, '--'])
    return withWarning({ uncommittedFiles, unpushedCommits: log.split('\n').filter(Boolean) })
  }

  async taskStatus(worktreePath: string, baseRef: string): Promise<TaskGitStatus> {
    // A ref starting with '-' would be read as an option; refuse it rather than pass it to git.
    const usableBase = baseRef !== '' && !baseRef.startsWith('-')
    const [porcelain, branch, last, counts] = await Promise.all([
      this.inspect(worktreePath, ['status', '--porcelain', '-z', '--untracked-files=normal']),
      this.inspect(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).then(
        (out) => out.trim(),
        () => 'HEAD', // unborn branch: no commit yet
      ),
      this.inspect(worktreePath, ['log', '-1', '--no-color', '--format=%h%x00%s%x00%cr', 'HEAD', '--']).then(
        parseLastCommit,
        () => undefined,
      ),
      // `--` makes git read the range as revisions only, never as a path.
      usableBase
        ? this.inspect(worktreePath, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`, '--']).then(
            parseLeftRightCount,
            () => null, // the base ref is gone (pruned, renamed) or was never fetched
          )
        : Promise.resolve(null),
    ])
    const status: TaskGitStatus = {
      ahead: counts?.ahead ?? 0,
      behind: counts?.behind ?? 0,
      uncommitted: parsePorcelainZ(porcelain).length,
      branch,
    }
    if (!counts) status.baseMissing = true
    if (last) status.lastCommit = last
    return status
  }

  async commitAll(worktreePath: string, message: string): Promise<CommitResult> {
    await this.work(worktreePath, ['add', '-A']).catch((err) => {
      throw commandFailure('git add', err)
    })
    const staged = splitZ(await this.work(worktreePath, ['diff', '--cached', '--name-only', '-z', '--no-renames']))
    if (staged.length === 0) throw new Error('Nothing to commit')
    // user.useConfigOnly: no identity guessed from the user and host names; git explains how to set one.
    await this.work(worktreePath, ['-c', 'user.useConfigOnly=true', 'commit', '-m', message], {
      timeoutMs: COMMIT_TIMEOUT_MS,
    }).catch((err) => {
      throw commandFailure('git commit', err, true)
    })
    const sha = (await this.work(worktreePath, ['rev-parse', '--short', 'HEAD'])).trim()
    return { sha, files: staged.length }
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    if (!branch || branch.startsWith('-')) throw new Error(`Invalid branch: ${branch}`)
    await this.work(worktreePath, ['push', '-u', 'origin', branch], {
      env: NON_INTERACTIVE_ENV,
      timeoutMs: PUSH_TIMEOUT_MS,
    }).catch((err) => {
      throw commandFailure('git push', err)
    })
  }
}
