import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../exec'
import { GitService } from './gitService'
import { commitFile, git, makeClonedRepo, makeLocalRepo } from './testRepos'

const svc = new GitService()

describe('repoRoot', () => {
  it('returns the top-level dir from a subfolder', async () => {
    const { clone } = await makeClonedRepo()
    await mkdir(join(clone, 'sub'))
    await expect(svc.repoRoot(join(clone, 'sub'))).resolves.toBe(clone)
  })
  it('returns null outside a repo', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'mm-norepo-')))
    await expect(svc.repoRoot(dir)).resolves.toBeNull()
  })
})

describe('fetch', () => {
  it('is a no-op without an origin remote', async () => {
    const { repo } = await makeLocalRepo()
    await expect(svc.fetch(repo)).resolves.toBeUndefined()
  })
  it('fetches from origin', async () => {
    const { clone } = await makeClonedRepo()
    await expect(svc.fetch(clone)).resolves.toBeUndefined()
  })
})

describe('resolveBaseRef', () => {
  it('uses origin/HEAD for clones', async () => {
    const { clone } = await makeClonedRepo()
    await expect(svc.resolveBaseRef(clone)).resolves.toBe('origin/main')
  })
  it('uses local main without a remote', async () => {
    const { repo } = await makeLocalRepo()
    await expect(svc.resolveBaseRef(repo)).resolves.toBe('main')
  })
})

async function withTask(): Promise<{ clone: string; wt: string; branch: string }> {
  const { root, clone } = await makeClonedRepo()
  const wt = join(root, 'worktrees', 'client-x', 'clone', 'fix')
  await svc.addWorktree(clone, wt, 'claude/client-x/fix', 'origin/main')
  return { clone, wt, branch: 'claude/client-x/fix' }
}

describe('addWorktree', () => {
  it('creates the worktree on a new branch without upstream', async () => {
    const { wt, branch } = await withTask()
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    expect((await run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branch)
    await expect(run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '@{u}'])).rejects.toThrow()
  })
})

describe('getUnsavedWork', () => {
  it('is empty for a fresh task', async () => {
    const { clone, wt, branch } = await withTask()
    await expect(svc.getUnsavedWork(clone, wt, branch, 'origin/main')).resolves.toEqual({
      uncommittedFiles: [],
      unpushedCommits: [],
    })
  })
  it('reports uncommitted files and unpushed commits', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await writeFile(join(wt, 'b.txt'), 'b')
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual(['b.txt'])
    expect(work.unpushedCommits).toHaveLength(1)
    expect(work.unpushedCommits[0]).toContain('add a')
  })
  it('treats pushed commits as safe', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await git(wt, 'push', 'origin', branch)
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.unpushedCommits).toEqual([])
  })
  it('uses baseRef when the repo has no remote', async () => {
    const { root, repo } = await makeLocalRepo()
    const wt = join(root, 'wt')
    await svc.addWorktree(repo, wt, 'claude/t/x', 'main')
    await commitFile(wt, 'a.txt', 'a', 'local change')
    const work = await svc.getUnsavedWork(repo, wt, 'claude/t/x', 'main')
    expect(work.unpushedCommits).toHaveLength(1)
  })
  it('still checks the branch when the worktree folder is gone', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await rm(wt, { recursive: true, force: true })
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual([])
    expect(work.unpushedCommits).toHaveLength(1)
  })
  it('warns instead of throwing when the original repo was moved', async () => {
    const { clone, wt, branch } = await withTask()
    await writeFile(join(wt, 'b.txt'), 'b')
    await rename(clone, clone + '-moved')
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual([])
    expect(work.unpushedCommits).toEqual([])
    expect(work.warning).toBe(
      `The original repository was not found at ${clone}, so uncommitted changes and unpushed commits could not be checked.`,
    )
  })
  it('warns when git status fails in an existing worktree', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await writeFile(join(wt, '.git'), 'gitdir: /nonexistent/worktree\n') // broken worktree link
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual([])
    expect(work.unpushedCommits).toHaveLength(1)
    expect(work.warning).toMatch(/uncommitted changes .* could not be checked/)
  })
})

describe('removeWorktree / deleteBranch', () => {
  it('removes a dirty worktree and deletes the branch', async () => {
    const { clone, wt, branch } = await withTask()
    await writeFile(join(wt, 'dirty.txt'), 'x')
    await svc.removeWorktree(clone, wt)
    await svc.deleteBranch(clone, branch)
    expect(existsSync(wt)).toBe(false)
    expect((await run('git', ['-C', clone, 'branch', '--list', branch])).trim()).toBe('')
  })
  it('prunes when the folder was deleted manually', async () => {
    const { clone, wt } = await withTask()
    await rm(wt, { recursive: true, force: true })
    await svc.removeWorktree(clone, wt)
    expect(await run('git', ['-C', clone, 'worktree', 'list'])).not.toContain(wt)
  })
  it('deletes the worktree folder when the original repo was moved', async () => {
    const { clone, wt } = await withTask()
    await writeFile(join(wt, 'dirty.txt'), 'x')
    await rename(clone, clone + '-moved')
    await svc.removeWorktree(clone, wt)
    expect(existsSync(wt)).toBe(false)
  })
})
