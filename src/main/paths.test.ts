import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { appHome, expandHome, stateFile, taskWorktreePath, worktreesRoot } from './paths'

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
  it('builds task worktree paths from slugs', () => {
    expect(taskWorktreePath('client-x', 'my-api', 'fix', '/root')).toBe(join('/root', 'client-x', 'my-api', 'fix'))
  })
  it('expands a leading ~/ to the home folder, and nothing else', () => {
    expect(expandHome('~/.claude-work', '/home/me')).toBe('/home/me/.claude-work')
    expect(expandHome('~/', '/home/me')).toBe('/home/me/')
    for (const dir of ['~', '~other/x', '/a/~/b', 'rel/~/x', ' ~/x']) expect(expandHome(dir, '/home/me')).toBe(dir)
  })
})
