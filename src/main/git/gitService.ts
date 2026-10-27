import { existsSync } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { checkCloneUrl } from '../../shared/clone'
import type { CommitResult, TaskGitStatus, UnsavedWork, UpdateResult, UpdateStrategy } from '../../shared/types'
import type { GitApi } from '../contracts'
import { CommandError, run } from '../exec'
import { GIT_ENV } from './gitEnv'
import { baseRefCandidates, resolveBaseRef } from './refs'

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
/** A rebase or merge replays commits (and may run hooks or sign them); it still mustn't hang forever. */
const UPDATE_TIMEOUT_MS = 120_000
/** A clone can be big and the network slow, but a GUI app can't wait forever for one that hangs. */
export const CLONE_TIMEOUT_MS = 10 * 60_000
/**
 * Off for every clone, whatever the user's config says: `ext::` runs a command and `fd::` reads file descriptors.
 * checkCloneUrl refuses them already; this is the second lock.
 */
const CLONE_PROTOCOL_GUARD = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never']

/** Message of the refusal to update a worktree with uncommitted changes. */
export const UNCOMMITTED_REFUSAL = 'Commit or stash your changes first'

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

export interface GitServiceOptions {
  /** Overrides CLONE_TIMEOUT_MS (for tests). */
  cloneTimeoutMs?: number
}

export class GitService implements GitApi {
  private readonly cloneTimeoutMs: number

  constructor(options: GitServiceOptions = {}) {
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS
  }

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

  /** Whether the full ref `ref` names a commit, read-only. */
  private async commitExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.inspect(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /** The full ref of a task's base name (see refs.ts), for every git call that takes it. */
  private fullRef(cwd: string, baseRef: string): Promise<string> {
    return resolveBaseRef(baseRef, (ref) => this.commitExists(cwd, ref))
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
    // A branch only: a tag (or anything else git would resolve the short name to) doesn't count.
    for (const full of baseRefCandidates(ref)) if (await this.commitExists(repoPath, full)) return true
    return false
  }

  async clone(url: string, dest: string): Promise<void> {
    const checked = checkCloneUrl(url)
    if (!isAbsolute(dest)) throw new Error(`Invalid clone destination: ${dest}`)
    // Created here, not by git: mkdir fails on a folder that exists, so a failed clone only ever removes ours.
    try {
      await mkdir(dest)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new Error(`${dest} already exists; choose another folder name`, { cause: err })
      if (code === 'ENOENT') throw new Error(`Folder not found: ${dirname(dest)}`, { cause: err })
      throw err
    }
    try {
      await run('git', [...CLONE_PROTOCOL_GUARD, 'clone', '--', checked, dest], {
        cwd: dirname(dest),
        env: { ...GIT_ENV, ...NON_INTERACTIVE_ENV },
        timeoutMs: this.cloneTimeoutMs,
      })
    } catch (err) {
      await rm(dest, { recursive: true, force: true }).catch(() => {})
      throw commandFailure('git clone', err)
    }
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void> {
    if (await this.refExists(repoPath, `refs/heads/${branch}`)) {
      throw new Error(
        `Branch "${branch}" already exists (kept from an earlier task). Delete it or choose another task name.`,
      )
    }
    const base = await this.fullRef(repoPath, baseRef)
    await mkdir(dirname(worktreePath), { recursive: true })
    try {
      // --no-track: otherwise the branch would track origin/main and `git push` would be confusing.
      await this.git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base])
    } catch (err) {
      // git makes the branch before the checkout and keeps it when the checkout fails (a filter like git-lfs
      // missing, a full disk), which would refuse the task's name from then on. It didn't exist (checked above).
      await this.git(repoPath, ['branch', '-D', branch]).catch(() => {})
      throw commandFailure('git worktree add', err)
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (!(await this.isRepo(repoPath))) {
      // Without the original repo git cannot remove it; there is nothing left to prune either.
      await rm(worktreePath, { recursive: true, force: true })
      return
    }
    if (!existsSync(worktreePath)) {
      await this.git(repoPath, ['worktree', 'prune'])
      return
    }
    try {
      await this.git(repoPath, ['worktree', 'remove', '--force', worktreePath])
    } catch (err) {
      if (!(await this.isBrokenWorktree(worktreePath))) throw err
      // git refuses it, which would keep the task forever; it is still the task's folder, so it goes like one whose
      // repo is gone.
      await rm(worktreePath, { recursive: true, force: true })
      await this.git(repoPath, ['worktree', 'prune'])
    }
  }

  /**
   * Whether `path` is a linked worktree whose link with its repo broke: it has the `.git` file git leaves in one,
   * but git can't open the repository through it (the repo's entry for it was pruned, the repo was cloned again,
   * or the file was changed). A repository's own folder has a `.git` folder instead, so it is never one.
   */
  private async isBrokenWorktree(path: string): Promise<boolean> {
    const link = await lstat(join(path, '.git')).catch(() => null)
    if (!link?.isFile()) return false
    return this.git(path, ['rev-parse', '--git-dir']).then(
      () => false,
      () => true,
    )
  }

  async restoreWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    if (!branch || branch.startsWith('-')) throw new Error(`Invalid branch: ${branch}`)
    if (!(await this.refExists(repoPath, `refs/heads/${branch}`))) {
      throw new Error(`The branch "${branch}" no longer exists, so the task can't be restored`)
    }
    if (existsSync(worktreePath))
      throw new Error(`${worktreePath} is already taken; move it away, then restore the task`)
    // A worktree folder deleted by hand leaves an entry that would make `worktree add` refuse the path.
    await this.git(repoPath, ['worktree', 'prune'])
    await mkdir(dirname(worktreePath), { recursive: true })
    await this.git(repoPath, ['worktree', 'add', worktreePath, branch]).catch((err) => {
      throw commandFailure('git worktree add', err)
    })
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
    const base = baseRef && !baseRef.startsWith('-') ? await this.fullRef(repoPath, baseRef) : ''
    const hasBase = base !== '' && (await this.refExists(repoPath, base))
    const head = `refs/heads/${branch}`
    const range = (await this.hasOrigin(repoPath))
      ? [head, '--not', '--remotes', ...(hasBase ? [base] : [])]
      : hasBase
        ? [`${base}..${head}`]
        : [head, '--not', `--exclude=${branch}`, '--branches']
    const log = await this.git(repoPath, ['log', '--format=%h %s', ...range, '--'])
    return withWarning({ uncommittedFiles, unpushedCommits: log.split('\n').filter(Boolean) })
  }

  async taskStatus(worktreePath: string, baseRef: string): Promise<TaskGitStatus> {
    // A ref starting with '-' would be read as an option; refuse it rather than pass it to git.
    const base = baseRef !== '' && !baseRef.startsWith('-') ? await this.fullRef(worktreePath, baseRef) : null
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
      base
        ? this.inspect(worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`, '--']).then(
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

  /** Whether a rebase or merge is stopped half-way in the worktree (its state files are in the worktree's git dir). */
  private async inProgress(worktreePath: string): Promise<'rebase' | 'merge' | null> {
    const paths = await this.work(worktreePath, [
      'rev-parse',
      '--git-path',
      'rebase-merge',
      '--git-path',
      'rebase-apply',
      '--git-path',
      'MERGE_HEAD',
    ])
    const [rebaseMerge, rebaseApply, mergeHead] = paths.split('\n').map((p) => resolve(worktreePath, p))
    if (existsSync(rebaseMerge) || existsSync(rebaseApply)) return 'rebase'
    return existsSync(mergeHead) ? 'merge' : null
  }

  async updateFromBase(worktreePath: string, baseRef: string, strategy: UpdateStrategy): Promise<UpdateResult> {
    if (!(await this.verifyRef(worktreePath, baseRef))) {
      throw new Error(`The base branch ${baseRef} was not found (deleted, or never fetched)`)
    }
    const base = await this.fullRef(worktreePath, baseRef)
    const running = await this.inProgress(worktreePath)
    if (running) throw new Error(`A ${running} is already in progress in this worktree; finish or abort it first`)
    // Untracked files don't stop a rebase or merge (git refuses by itself if one would be overwritten).
    const changed = parsePorcelainZ(
      await this.work(worktreePath, ['status', '--porcelain', '-z', '--untracked-files=no']),
    )
    if (changed.length > 0) {
      const n = changed.length
      throw new Error(`${UNCOMMITTED_REFUSAL}: ${n} uncommitted ${n === 1 ? 'file' : 'files'} in the task`)
    }
    const behind = Number((await this.work(worktreePath, ['rev-list', '--count', `HEAD..${base}`, '--'])).trim())
    if (behind === 0) return { kind: 'upToDate', baseRef }

    const args = strategy === 'merge' ? ['merge', '--no-edit', base] : ['rebase', base]
    try {
      // No editor ever opens (a GUI app has no terminal for it); identity as for "Commit all".
      await this.work(worktreePath, ['-c', 'user.useConfigOnly=true', ...args], {
        env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
        timeoutMs: UPDATE_TIMEOUT_MS,
      })
    } catch (err) {
      const unmerged = await this.work(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']).then(
        splitZ,
        () => [] as string[],
      )
      const stopped = await this.inProgress(worktreePath)
      if (stopped) await this.work(worktreePath, [stopped, '--abort'])
      if (unmerged.length > 0) return { kind: 'conflict', strategy, baseRef, files: [...new Set(unmerged)] }
      throw commandFailure(`git ${strategy}`, err, true)
    }
    return { kind: 'updated', strategy, baseRef, commits: behind }
  }
}
