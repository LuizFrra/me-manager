import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../exec'
import { GitService, parseLastCommit, parseLeftRightCount } from './gitService'
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
  it('ignores a dangling origin/HEAD', async () => {
    const { clone } = await makeClonedRepo()
    await git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone')
    await expect(svc.resolveBaseRef(clone)).resolves.toBe('origin/main')
  })
  it('uses local main without a remote', async () => {
    const { repo } = await makeLocalRepo()
    await expect(svc.resolveBaseRef(repo)).resolves.toBe('main')
  })
})

async function withTask(): Promise<{ root: string; clone: string; wt: string; branch: string }> {
  const { root, clone } = await makeClonedRepo()
  const wt = join(root, 'worktrees', 'client-x', 'clone', 'fix')
  await svc.addWorktree(clone, wt, 'claude/client-x/fix', 'origin/main')
  return { root, clone, wt, branch: 'claude/client-x/fix' }
}

describe('addWorktree', () => {
  it('creates the worktree on a new branch without upstream', async () => {
    const { wt, branch } = await withTask()
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    expect((await run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branch)
    await expect(run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '@{u}'])).rejects.toThrow()
  })
})

describe('addWorktree with a kept branch', () => {
  it('explains that the branch already exists', async () => {
    const { clone, wt, branch } = await withTask()
    await svc.removeWorktree(clone, wt) // task removed, branch kept
    await expect(svc.addWorktree(clone, wt, branch, 'origin/main')).rejects.toThrow(
      `Branch "${branch}" already exists (kept from an earlier task). Delete it or choose another task name.`,
    )
    expect(existsSync(wt)).toBe(false)
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
  it('reports file names with spaces and non-ASCII verbatim', async () => {
    const { clone, wt, branch } = await withTask()
    await writeFile(join(wt, 'my file ç.txt'), 'x')
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual(['my file ç.txt'])
  })
  it('reports only the new name of a renamed file', async () => {
    const { clone, wt, branch } = await withTask()
    await git(wt, 'mv', 'README.md', 'read me ç.md')
    await writeFile(join(wt, 'other.txt'), 'x')
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual(['read me ç.md', 'other.txt'])
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
  it('does not report the base history when origin has no fetched refs', async () => {
    const { root, repo } = await makeLocalRepo()
    await git(repo, 'remote', 'add', 'origin', join(root, 'nonexistent.git'))
    const baseRef = await svc.resolveBaseRef(repo)
    const wt = join(root, 'wt')
    await svc.addWorktree(repo, wt, 'claude/t/x', baseRef)
    const work = await svc.getUnsavedWork(repo, wt, 'claude/t/x', baseRef)
    expect(work.unpushedCommits).toEqual([])
    await commitFile(wt, 'a.txt', 'a', 'local change')
    const after = await svc.getUnsavedWork(repo, wt, 'claude/t/x', baseRef)
    expect(after.unpushedCommits).toHaveLength(1)
  })
  it('still works when the base ref no longer exists', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/gone')
    expect(work.unpushedCommits).toHaveLength(1)
    const { root, repo } = await makeLocalRepo()
    const localWt = join(root, 'wt')
    await svc.addWorktree(repo, localWt, 'claude/t/x', 'main')
    await commitFile(localWt, 'a.txt', 'a', 'local change')
    const local = await svc.getUnsavedWork(repo, localWt, 'claude/t/x', 'gone')
    expect(local.unpushedCommits).toHaveLength(1)
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

describe('taskStatus', () => {
  it('is clean and level with the base for a fresh task', async () => {
    const { wt, branch } = await withTask()
    const status = await svc.taskStatus(wt, 'origin/main')
    expect(status).toMatchObject({ ahead: 0, behind: 0, uncommitted: 0, branch })
    expect(status.baseMissing).toBeUndefined()
    expect(status.lastCommit).toMatchObject({ subject: 'init' })
    expect(status.lastCommit?.sha).toMatch(/^[0-9a-f]{4,}$/)
    expect(status.lastCommit?.relativeDate).toMatch(/ago|now/)
  })

  it('counts commits ahead and behind the base, and uncommitted files', async () => {
    const { root, clone, wt } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await commitFile(wt, 'b.txt', 'b', 'add b: a subject with spaces')
    // Someone else pushes to main; after a fetch the task is one commit behind origin/main.
    const other = join(root, 'other')
    await run('git', ['clone', join(root, 'origin.git'), other])
    await commitFile(other, 'c.txt', 'c', 'upstream change')
    await git(other, 'push', 'origin', 'main')
    await git(clone, 'fetch', 'origin')
    await writeFile(join(wt, 'untracked ç.txt'), 'x')
    await writeFile(join(wt, 'README.md'), 'changed\n')
    const status = await svc.taskStatus(wt, 'origin/main')
    expect(status).toMatchObject({ ahead: 2, behind: 1, uncommitted: 2 })
    expect(status.lastCommit?.subject).toBe('add b: a subject with spaces')
  })

  it('counts a rename once', async () => {
    const { wt } = await withTask()
    await git(wt, 'mv', 'README.md', 'read me.md')
    await expect(svc.taskStatus(wt, 'origin/main')).resolves.toMatchObject({ uncommitted: 1 })
  })

  it('flags a missing base ref and reports 0 ahead/behind', async () => {
    const { wt } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    const status = await svc.taskStatus(wt, 'origin/gone')
    expect(status).toMatchObject({ ahead: 0, behind: 0, baseMissing: true })
    expect(status.lastCommit?.subject).toBe('add a')
  })

  it('refuses a base ref that looks like an option', async () => {
    const { wt } = await withTask()
    const marker = join(wt, 'PWNED')
    const status = await svc.taskStatus(wt, `--output=${marker}`)
    expect(status).toMatchObject({ ahead: 0, behind: 0, baseMissing: true })
    expect(existsSync(marker)).toBe(false)
  })

  it('reports a detached HEAD', async () => {
    const { wt } = await withTask()
    await git(wt, 'checkout', '--detach')
    await expect(svc.taskStatus(wt, 'origin/main')).resolves.toMatchObject({ branch: 'HEAD', ahead: 0 })
  })

  it('still works while another git process holds index.lock', async () => {
    const { wt } = await withTask()
    await writeFile(join(wt, 'README.md'), 'changed\n')
    const gitDir = (await git(wt, 'rev-parse', '--git-dir')).trim()
    await writeFile(join(gitDir, 'index.lock'), '')
    await expect(svc.taskStatus(wt, 'origin/main')).resolves.toMatchObject({ uncommitted: 1 })
    await rm(join(gitDir, 'index.lock'))
  })

  it('rejects outside a git work tree', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'mm-norepo-')))
    await expect(svc.taskStatus(dir, 'origin/main')).rejects.toThrow()
  })
})

describe('taskStatus parsers', () => {
  it('reads rev-list --left-right --count as behind, ahead', () => {
    expect(parseLeftRightCount('1\t3\n')).toEqual({ behind: 1, ahead: 3 })
    expect(parseLeftRightCount('garbage')).toBeNull()
  })
  it('reads the last commit, keeping subjects verbatim', () => {
    expect(parseLastCommit('abc1234\0fix: a | b\0' + '2 hours ago\n')).toEqual({
      sha: 'abc1234',
      subject: 'fix: a | b',
      relativeDate: '2 hours ago',
    })
    expect(parseLastCommit('')).toBeUndefined()
  })
})
