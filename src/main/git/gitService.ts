import type { UnsavedWork } from '../../shared/types'
import type { GitApi } from '../contracts'
import { run } from '../exec'

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
    if (await this.hasOrigin(repoPath)) await this.git(repoPath, ['fetch', 'origin', '--prune'])
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

  async addWorktree(): Promise<void> {
    throw new Error('not implemented')
  }

  async removeWorktree(): Promise<void> {
    throw new Error('not implemented')
  }

  async deleteBranch(): Promise<void> {
    throw new Error('not implemented')
  }

  async getUnsavedWork(): Promise<UnsavedWork> {
    throw new Error('not implemented')
  }
}
