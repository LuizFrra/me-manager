import { describe, expect, it } from 'vitest'
import { baseRefCandidates, resolveBaseRef } from './refs'

describe('baseRefCandidates', () => {
  it("prefers origin's branch for origin/…, a local branch otherwise, and keeps full refs and HEAD", () => {
    expect(baseRefCandidates('origin/main')).toEqual(['refs/remotes/origin/main', 'refs/heads/origin/main'])
    expect(baseRefCandidates('main')).toEqual(['refs/heads/main'])
    expect(baseRefCandidates('feature/x')).toEqual(['refs/heads/feature/x'])
    expect(baseRefCandidates('refs/remotes/origin/dev')).toEqual(['refs/remotes/origin/dev'])
    expect(baseRefCandidates('HEAD')).toEqual(['HEAD'])
  })
})

describe('resolveBaseRef', () => {
  it('takes the first candidate that exists, or the preferred one', async () => {
    const has = (refs: string[]) => async (ref: string) => refs.includes(ref)
    await expect(resolveBaseRef('origin/x', has(['refs/heads/origin/x']))).resolves.toBe('refs/heads/origin/x')
    await expect(resolveBaseRef('origin/x', has([]))).resolves.toBe('refs/remotes/origin/x')
    await expect(resolveBaseRef('main', has([]))).resolves.toBe('refs/heads/main')
    await expect(resolveBaseRef('-x', has([]))).rejects.toThrow('Invalid base branch')
  })
})
