import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { appHome, expandHome, stateFile, taskWorktreePath, usageCacheFile, worktreesRoot } from './paths'

describe('paths', () => {
  afterEach(() => {
    delete process.env.ME_MANAGER_HOME
  })
  it('honours ME_MANAGER_HOME', () => {
    process.env.ME_MANAGER_HOME = '/tmp/mm'
    expect(appHome()).toBe('/tmp/mm')
    expect(stateFile()).toBe(join('/tmp/mm', 'state.json'))
    expect(worktreesRoot()).toBe(join('/tmp/mm', 'worktrees'))
  })
  it('keeps the usage cache of the Default folder where it always was, and one per other folder by its hash', () => {
    expect(usageCacheFile(undefined, '/h')).toBe(join('/h', 'usage-cache.json'))
    expect(usageCacheFile('0123abcd', '/h')).toBe(join('/h', 'usage-cache-0123abcd.json'))
  })
  it('builds task worktree paths from slugs', () => {
    expect(taskWorktreePath('client-x', 'my-api', 'fix', '/root')).toBe(join('/root', 'client-x', 'my-api', 'fix'))
  })
  it('expands a leading ~/ to the home folder, and nothing else', () => {
    expect(expandHome('~/.claude-work', '/home/me')).toBe('/home/me/.claude-work')
    expect(expandHome('~/', '/home/me')).toBe('/home/me/')
    for (const dir of ['~', '~other/x', '/a/~/b', 'rel/~/x', ' ~/x']) expect(expandHome(dir, '/home/me')).toBe(dir)
  })
})
