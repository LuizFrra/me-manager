import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { CommandError } from '../exec'
import {
  commandFailure,
  GitService,
  parseBranchRefs,
  parseLastCommit,
  parseLeftRightCount,
  summarizeGitError,
} from './gitService'
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

describe('listBranches / verifyRef', () => {
  it("lists origin's branches without origin/HEAD, then the local ones", async () => {
    const { root, clone } = await makeClonedRepo()
    // Another clone pushes a feature branch; ours sees it after a fetch.
    const other = join(root, 'other')
    await run('git', ['clone', join(root, 'origin.git'), other])
    await git(other, 'checkout', '-b', 'feature/login')
    await commitFile(other, 'login.txt', 'x\n', 'login')
    await git(other, 'push', 'origin', 'feature/login')
    await svc.fetch(clone)
    await git(clone, 'branch', 'local-only')
    await expect(svc.listBranches(clone)).resolves.toEqual([
      'origin/feature/login',
      'origin/main',
      'local-only',
      'main',
    ])
  })

  it('lists only local branches without a remote', async () => {
    const { repo } = await makeLocalRepo()
    await expect(svc.listBranches(repo)).resolves.toEqual(['main'])
  })

  it('verifies refs, refusing option-like ones', async () => {
    const { clone } = await makeClonedRepo()
    await expect(svc.verifyRef(clone, 'origin/main')).resolves.toBe(true)
    await expect(svc.verifyRef(clone, 'main')).resolves.toBe(true)
    await expect(svc.verifyRef(clone, 'origin/nope')).resolves.toBe(false)
    await expect(svc.verifyRef(clone, '--all')).resolves.toBe(false)
    await expect(svc.verifyRef(clone, '')).resolves.toBe(false)
  })

  it("parses full ref names, listing a local branch named like one of origin's only once", () => {
    const out = [
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
      'refs/remotes/origin/a/b',
      'refs/heads/origin/main',
      'refs/heads/dev',
      '',
    ].join('\n')
    expect(parseBranchRefs(out)).toEqual(['origin/a/b', 'origin/main', 'dev'])
  })
})

async function withTask(): Promise<{ root: string; clone: string; wt: string; branch: string }> {
  const { root, clone } = await makeClonedRepo()
  const wt = join(root, 'worktrees', 'client-x', 'clone', 'fix')
  await svc.addWorktree(clone, wt, 'claude/client-x/fix', 'origin/main')
  return { root, clone, wt, branch: 'claude/client-x/fix' }
}

describe('clone', () => {
  /** A bare origin with one commit (from makeClonedRepo), and an empty folder to clone into. */
  async function origin(): Promise<{ url: string; parent: string }> {
    const { root } = await makeClonedRepo()
    const parent = join(root, 'into')
    await mkdir(parent)
    return { url: `file://${join(root, 'origin.git')}`, parent }
  }

  it('clones a file:// repository into a new folder', async () => {
    const { url, parent } = await origin()
    const dest = join(parent, 'my-api')
    await svc.clone(url, dest)
    expect(existsSync(join(dest, 'README.md'))).toBe(true)
    expect((await git(dest, 'remote', 'get-url', 'origin')).trim()).toBe(url)
    await expect(svc.resolveBaseRef(dest)).resolves.toBe('origin/main')
  })

  it('refuses a folder that exists, leaving it as it was', async () => {
    const { url, parent } = await origin()
    const dest = join(parent, 'taken')
    await mkdir(dest)
    await writeFile(join(dest, 'mine.txt'), 'keep me')
    await expect(svc.clone(url, dest)).rejects.toThrow(`${dest} already exists`)
    expect(existsSync(join(dest, 'mine.txt'))).toBe(true)
  })

  it('removes the folder it created when the clone fails', async () => {
    const { parent } = await origin()
    const dest = join(parent, 'broken')
    await expect(svc.clone(`file://${join(parent, 'nope.git')}`, dest)).rejects.toThrow(/^git clone failed: /)
    expect(existsSync(dest)).toBe(false)
  })

  it('removes the folder when the clone times out', async () => {
    const { url, parent } = await origin()
    const dest = join(parent, 'slow')
    await expect(new GitService({ cloneTimeoutMs: 1 }).clone(url, dest)).rejects.toThrow(/git clone timed out/)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses options and command transports before creating anything', async () => {
    const { parent } = await origin()
    const dest = join(parent, 'x')
    await expect(svc.clone('-u touch /tmp/pwned', dest)).rejects.toThrow(/start with “-”/)
    await expect(svc.clone('--upload-pack=touch', dest)).rejects.toThrow(/start with “-”/)
    await expect(svc.clone('ext::sh', dest)).rejects.toThrow(/ext:: and fd::/)
    await expect(svc.clone('ext::sh -c touch% /tmp/pwned', dest)).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
  })

  it('needs an absolute destination whose parent exists', async () => {
    const { url, parent } = await origin()
    await expect(svc.clone(url, 'relative/x')).rejects.toThrow(/Invalid clone destination/)
    await expect(svc.clone(url, join(parent, 'missing', 'x'))).rejects.toThrow(
      `Folder not found: ${join(parent, 'missing')}`,
    )
  })
})

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

/** Runs the tests with only the given git config as the global one: no identity, signing or hooks of the machine's. */
function withGlobalConfig(config: string): void {
  const keys = [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'EMAIL',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]
  const saved = new Map(keys.map((k) => [k, process.env[k]]))
  beforeAll(async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'mm-gitconfig-')))
    await writeFile(join(dir, 'gitconfig'), config)
    for (const k of keys) delete process.env[k]
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
  })
  afterAll(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

const NO_SIGNING = '[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n'

describe('commitAll', () => {
  withGlobalConfig(`[user]\n\tname = Test\n\temail = test@example.com\n${NO_SIGNING}`)

  it('stages everything (new, changed, deleted) and commits it with the message verbatim', async () => {
    const { wt } = await withTask()
    await commitFile(wt, 'old.txt', 'old\n', 'add old')
    await writeFile(join(wt, 'README.md'), 'changed\n')
    await writeFile(join(wt, 'new file ç.txt'), 'new\n')
    await rm(join(wt, 'old.txt'))
    const message = '-fix: the login\n\n# not a comment\nbody $(id)'
    const result = await svc.commitAll(wt, message)
    expect(result.files).toBe(3)
    expect(result.sha).toBe((await git(wt, 'rev-parse', '--short', 'HEAD')).trim())
    expect(await git(wt, 'log', '-1', '--format=%B')).toBe(`${message}\n\n`)
    expect(await git(wt, 'status', '--porcelain')).toBe('')
    expect(
      (await git(wt, '-c', 'core.quotepath=false', 'show', '--name-status', '--format=', 'HEAD'))
        .split('\n')
        .filter(Boolean)
        .sort(),
    ).toEqual(['D\told.txt', 'M\tREADME.md', 'A\tnew file ç.txt'].sort())
  })

  it('refuses when there is nothing to commit', async () => {
    const { wt } = await withTask()
    const before = await git(wt, 'rev-parse', 'HEAD')
    await expect(svc.commitAll(wt, 'nothing')).rejects.toThrow('Nothing to commit')
    expect(await git(wt, 'rev-parse', 'HEAD')).toBe(before)
  })
})

describe('commitAll without an identity', () => {
  withGlobalConfig(NO_SIGNING)

  it("fails with git's message instead of guessing one", async () => {
    const { wt } = await withTask()
    const before = await git(wt, 'rev-parse', 'HEAD')
    await writeFile(join(wt, 'a.txt'), 'a\n')
    const err = await svc.commitAll(wt, 'add a').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^git commit failed: Author identity unknown .*Please tell me who you are/)
    expect((err as Error).message).toMatch(/auto-detection is disabled/)
    expect(await git(wt, 'rev-parse', 'HEAD')).toBe(before)
  })
})

describe('push', () => {
  withGlobalConfig(`[user]\n\tname = Test\n\temail = test@example.com\n${NO_SIGNING}`)

  it('pushes the branch to origin and sets it as the upstream', async () => {
    const { root, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a\n', 'add a')
    await svc.push(wt, branch)
    expect((await git(wt, 'rev-parse', '--abbrev-ref', '@{u}')).trim()).toBe(`origin/${branch}`)
    const remote = await run('git', ['-C', join(root, 'origin.git'), 'rev-parse', `refs/heads/${branch}`])
    expect(remote).toBe(await git(wt, 'rev-parse', 'HEAD'))
    // Up to date: pushing again succeeds.
    await expect(svc.push(wt, branch)).resolves.toBeUndefined()
  })

  it("summarizes git's error when the push is rejected, without hints", async () => {
    const { root, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a\n', 'add a')
    await svc.push(wt, branch)
    // Someone else pushes to the branch; our amended commit no longer fast-forwards.
    const other = join(root, 'other')
    await run('git', ['clone', '-b', branch, join(root, 'origin.git'), other])
    await commitFile(other, 'b.txt', 'b\n', 'add b')
    await git(other, 'push', 'origin', branch)
    await git(wt, 'commit', '--amend', '-m', 'add a, amended')
    const err = (await svc.push(wt, branch).catch((e: Error) => e)) as Error
    expect(err.message).toMatch(/^git push failed: ! \[rejected\]\s+claude\/client-x\/fix -> claude\/client-x\/fix/)
    expect(err.message).toContain('error: failed to push some refs')
    expect(err.message).not.toContain('hint:')
  })

  it('fails without prompting when origin is unreachable', async () => {
    const { clone, wt, branch } = await withTask()
    await git(clone, 'remote', 'set-url', 'origin', join(clone, 'missing.git'))
    await expect(svc.push(wt, branch)).rejects.toThrow(
      /^git push failed: fatal: .*does not appear to be a git repository/,
    )
  })

  it('refuses an option-like branch', async () => {
    const { wt } = await withTask()
    await expect(svc.push(wt, '--mirror')).rejects.toThrow('Invalid branch: --mirror')
  })
})

describe('git error summaries', () => {
  it('keeps the fatal, error and rejected lines, dropping hints', () => {
    const stderr = [
      'To github.com:acme/api.git',
      ' ! [rejected]        x -> x (fetch first)',
      "error: failed to push some refs to 'github.com:acme/api.git'",
      'hint: Updates were rejected because the remote contains work that you do not',
      'hint: have locally.',
      '',
    ].join('\n')
    expect(summarizeGitError(stderr)).toBe(
      "! [rejected] x -> x (fetch first) error: failed to push some refs to 'github.com:acme/api.git'",
    )
    expect(summarizeGitError('To x\nsomething odd\n')).toBe('To x something odd')
    expect(summarizeGitError(`fatal: ${'x'.repeat(1000)}`)).toHaveLength(500)
  })

  it('words a timeout and passes on errors that are not command failures', () => {
    const timedOut = new CommandError(
      'git push -u origin x',
      null,
      '',
      'git push -u origin x timed out after 60 s',
      true,
    )
    expect(commandFailure('git push', timedOut).message).toBe('git push timed out after 60 s')
    const plain = new Error('boom')
    expect(commandFailure('git push', plain)).toBe(plain)
    const noStderr = new CommandError('git x', 1, '', 'git x failed: exit code 1')
    expect(commandFailure('git x', noStderr).message).toBe('git x failed: exit code 1')
  })
})

describe('updateFromBase', () => {
  withGlobalConfig(`[user]\n\tname = Test\n\temail = test@example.com\n${NO_SIGNING}`)

  /** A task with one commit of its own, and `main` on origin moved on by another clone (then fetched). */
  async function behindBase(theirs: { file: string; content: string }): Promise<{ wt: string; clone: string }> {
    const { root, clone, wt } = await withTask()
    await commitFile(wt, 'mine.txt', 'mine\n', 'mine')
    const other = join(root, 'other')
    await run('git', ['clone', join(root, 'origin.git'), other])
    await commitFile(other, theirs.file, theirs.content, 'theirs')
    await git(other, 'push', 'origin', 'main')
    await svc.fetch(clone)
    return { wt, clone }
  }

  const log = async (wt: string): Promise<string[]> =>
    (await git(wt, 'log', '--format=%s', 'HEAD')).split('\n').filter(Boolean)

  it('is up to date when the base has nothing new', async () => {
    const { wt } = await withTask()
    await expect(svc.updateFromBase(wt, 'origin/main', 'rebase')).resolves.toEqual({
      kind: 'upToDate',
      baseRef: 'origin/main',
    })
  })

  it("rebases the task's commits onto the base", async () => {
    const { wt } = await behindBase({ file: 'theirs.txt', content: 'theirs\n' })
    await expect(svc.updateFromBase(wt, 'origin/main', 'rebase')).resolves.toEqual({
      kind: 'updated',
      strategy: 'rebase',
      baseRef: 'origin/main',
      commits: 1,
    })
    expect(await log(wt)).toEqual(['mine', 'theirs', 'init'])
    expect(await git(wt, 'status', '--porcelain')).toBe('')
  })

  it('merges the base with a merge commit', async () => {
    const { wt } = await behindBase({ file: 'theirs.txt', content: 'theirs\n' })
    await expect(svc.updateFromBase(wt, 'origin/main', 'merge')).resolves.toMatchObject({
      kind: 'updated',
      strategy: 'merge',
      commits: 1,
    })
    expect((await git(wt, 'log', '-1', '--format=%P')).trim().split(' ')).toHaveLength(2)
    expect(existsSync(join(wt, 'theirs.txt'))).toBe(true)
  })

  for (const strategy of ['rebase', 'merge'] as const) {
    it(`reports conflicts and aborts the ${strategy}, leaving a clean tree on the old commit`, async () => {
      const { root, clone, wt } = await withTask()
      await commitFile(wt, 'README.md', 'mine\n', 'mine')
      await commitFile(wt, 'other.md', 'mine\n', 'other')
      const head = await git(wt, 'rev-parse', 'HEAD')
      const other = join(root, 'other')
      await run('git', ['clone', join(root, 'origin.git'), other])
      await writeFile(join(other, 'other.md'), 'theirs\n')
      await commitFile(other, 'README.md', 'theirs\n', 'theirs')
      await git(other, 'push', 'origin', 'main')
      await svc.fetch(clone)

      const result = await svc.updateFromBase(wt, 'origin/main', strategy)
      expect(result).toMatchObject({ kind: 'conflict', strategy, baseRef: 'origin/main' })
      expect(result.kind === 'conflict' && result.files.sort()).toEqual(
        strategy === 'merge' ? ['README.md', 'other.md'] : ['README.md'], // a rebase stops at the first commit
      )
      expect(await git(wt, 'rev-parse', 'HEAD')).toBe(head)
      expect(await git(wt, 'status', '--porcelain')).toBe('')
      expect((await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('claude/client-x/fix')
      const gitDir = (await git(wt, 'rev-parse', '--git-dir')).trim()
      expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false)
      expect(existsSync(join(gitDir, 'MERGE_HEAD'))).toBe(false)
    })
  }

  it('refuses when tracked files have uncommitted changes, before touching anything', async () => {
    const { wt } = await behindBase({ file: 'theirs.txt', content: 'theirs\n' })
    await writeFile(join(wt, 'README.md'), 'edited\n')
    await writeFile(join(wt, 'scratch.txt'), 'untracked\n')
    const head = await git(wt, 'rev-parse', 'HEAD')
    await expect(svc.updateFromBase(wt, 'origin/main', 'rebase')).rejects.toThrow(
      'Commit or stash your changes first: 1 uncommitted file in the task',
    )
    expect(await git(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(await git(wt, 'status', '--porcelain')).toBe(' M README.md\n?? scratch.txt\n')
  })

  it('updates with only untracked files around', async () => {
    const { wt } = await behindBase({ file: 'theirs.txt', content: 'theirs\n' })
    await writeFile(join(wt, 'scratch.txt'), 'untracked\n')
    await expect(svc.updateFromBase(wt, 'origin/main', 'rebase')).resolves.toMatchObject({ kind: 'updated' })
  })

  it('refuses a missing or option-like base, and a rebase already in progress', async () => {
    const { wt } = await withTask()
    await expect(svc.updateFromBase(wt, 'origin/gone', 'rebase')).rejects.toThrow(/origin\/gone was not found/)
    await expect(svc.updateFromBase(wt, '--root', 'rebase')).rejects.toThrow(/--root was not found/)
    const gitDir = (await git(wt, 'rev-parse', '--git-dir')).trim()
    await mkdir(join(gitDir, 'rebase-merge'))
    await expect(svc.updateFromBase(wt, 'origin/main', 'merge')).rejects.toThrow(
      'A rebase is already in progress in this worktree; finish or abort it first',
    )
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(true) // the user's own rebase is left alone
  })
})

/**
 * A clone whose short base name `origin/main` is shadowed by `kind` (a tag, or a local branch named `origin/main`)
 * on an unrelated commit: git's own lookup picks that over the remote-tracking branch.
 */
async function shadowedBase(kind: 'tag' | 'branch'): Promise<{ clone: string; mainSha: string }> {
  const { clone } = await makeClonedRepo()
  const mainSha = (await git(clone, 'rev-parse', 'refs/remotes/origin/main')).trim()
  await git(clone, 'checkout', '-q', '--orphan', 'unrelated')
  await commitFile(clone, 'other.txt', 'other\n', 'unrelated')
  if (kind === 'tag') await git(clone, 'tag', 'origin/main')
  else await git(clone, 'branch', 'origin/main')
  await git(clone, 'checkout', '-q', 'main')
  await git(clone, 'branch', '-D', 'unrelated')
  // git itself now reads `origin/main` as the other commit.
  expect((await git(clone, 'rev-parse', 'origin/main')).trim()).not.toBe(mainSha)
  return { clone, mainSha }
}

describe.each(['tag', 'branch'] as const)('a base name shadowed by a %s', (kind) => {
  it("verifies it and starts a task from origin's branch", async () => {
    const { clone, mainSha } = await shadowedBase(kind)
    await expect(svc.verifyRef(clone, 'origin/main')).resolves.toBe(true)
    const wt = join(clone, '..', 'wt-shadow')
    await svc.addWorktree(clone, wt, 'claude/t/shadow', 'origin/main')
    expect((await git(wt, 'rev-parse', 'HEAD')).trim()).toBe(mainSha)
  })

  it("counts ahead/behind against origin's branch, and finds nothing to update", async () => {
    const { clone } = await shadowedBase(kind)
    const wt = join(clone, '..', 'wt-shadow')
    await svc.addWorktree(clone, wt, 'claude/t/shadow', 'origin/main')
    await expect(svc.taskStatus(wt, 'origin/main')).resolves.toMatchObject({ ahead: 0, behind: 0 })
    await expect(svc.taskStatus(wt, 'origin/main')).resolves.not.toHaveProperty('baseMissing')
    await expect(svc.updateFromBase(wt, 'origin/main', 'rebase')).resolves.toEqual({
      kind: 'upToDate',
      baseRef: 'origin/main',
    })
    await expect(svc.updateFromBase(wt, 'origin/main', 'merge')).resolves.toEqual({
      kind: 'upToDate',
      baseRef: 'origin/main',
    })
  })
})

describe('a local base name shadowed by a tag', () => {
  it('reports unpushed commits against the branch, not the tag', async () => {
    const { repo } = await makeLocalRepo()
    const wt = join(repo, '..', 'wt-local')
    await svc.addWorktree(repo, wt, 'claude/t/local', 'main')
    await commitFile(wt, 'task.txt', 'x\n', 'task work')
    await git(repo, 'tag', 'main', 'claude/t/local') // `main` now reads as the task's own commit
    const work = await svc.getUnsavedWork(repo, wt, 'claude/t/local', 'main')
    expect(work.unpushedCommits.map((c) => c.replace(/^\S+ /, ''))).toEqual(['task work'])
    await expect(svc.taskStatus(wt, 'main')).resolves.toMatchObject({ ahead: 1, behind: 0 })
  })

  it('refuses a base name that is only a tag', async () => {
    const { repo } = await makeLocalRepo()
    await git(repo, 'tag', 'v1')
    await expect(svc.verifyRef(repo, 'v1')).resolves.toBe(false)
    await expect(svc.verifyRef(repo, 'main')).resolves.toBe(true)
  })
})
