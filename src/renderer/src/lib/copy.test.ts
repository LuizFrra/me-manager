import { describe, expect, it } from 'vitest'
import { attachCommand, copyEntries, shellQuote } from './copy'
import { folder, repo, task, theme } from '../test/fixtures'

describe('shellQuote', () => {
  it('leaves safe words alone and single-quotes the rest', () => {
    expect(shellQuote('me-manager')).toBe('me-manager')
    expect(shellQuote('mmt_a_b_c')).toBe('mmt_a_b_c')
    expect(shellQuote('my socket')).toBe("'my socket'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'")
  })
})

describe('attachCommand', () => {
  it('names the socket and the session', () => {
    expect(attachCommand('me-manager', 'mmt_client-x_api_fix')).toBe(
      'tmux -L me-manager attach -t mmt_client-x_api_fix',
    )
  })
})

describe('copyEntries', () => {
  const t = { ...task('fix'), branch: 'claude/client-x/fix', worktreePath: '/wt/client-x/api/fix' }
  const r = repo('api', [t])
  const f = folder('notes')
  const th = { ...theme('Client X', [r, f]), slug: 'client-x' }

  it("lists a task's branch, worktree path and attach command", () => {
    expect(copyEntries({ theme: th, item: r, task: t }, 'me-manager').map((e) => [e.label, e.text])).toEqual([
      ['Copy branch name', 'claude/client-x/fix'],
      ['Copy worktree path', '/wt/client-x/api/fix'],
      ['Copy attach command', 'tmux -L me-manager attach -t mmt_client-x_api_fix'],
    ])
  })

  it("lists a folder's path and attach command", () => {
    expect(copyEntries({ theme: th, item: f }, 'sock').map((e) => [e.label, e.text])).toEqual([
      ['Copy folder path', '/f/notes'],
      ['Copy attach command', 'tmux -L sock attach -t mmf_client-x_notes'],
    ])
  })

  it('leaves out the attach command until the socket is known', () => {
    expect(copyEntries({ theme: th, item: f }, null).map((e) => e.kind)).toEqual(['path'])
  })
})
