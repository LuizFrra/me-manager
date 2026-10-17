import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitService } from './gitService'
import { makeClonedRepo, makeLocalRepo } from './testRepos'

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
