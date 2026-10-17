import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UnsavedWork } from '../../shared/types'
import type { GitApi } from '../contracts'
import { run } from '../exec'

/** A GUI app has no terminal to answer credential prompts, so fail fast instead of hanging. */
const FETCH_TIMEOUT_MS = 30_000
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
}

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

export class GitService implements GitApi {
  private git(cwd: string, args: string[]): Promise<string> {
    return run('git', ['-C', cwd, ...args])
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
}
