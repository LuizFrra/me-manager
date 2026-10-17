import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
        if (head) return head
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
    await mkdir(dirname(worktreePath), { recursive: true })
    // --no-track: otherwise the branch would track origin/main and `git push` would be confusing.
    await this.git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseRef])
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
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
    const uncommittedFiles = existsSync(worktreePath)
      ? (await this.git(worktreePath, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3))
      : []
    if (!(await this.refExists(repoPath, `refs/heads/${branch}`))) {
      return { uncommittedFiles, unpushedCommits: [] }
    }
    const range = (await this.hasOrigin(repoPath)) ? [branch, '--not', '--remotes'] : [`${baseRef}..${branch}`]
    const log = await this.git(repoPath, ['log', '--format=%h %s', ...range, '--'])
    return { uncommittedFiles, unpushedCommits: log.split('\n').filter(Boolean) }
  }
}
