import { describe, expect, it } from 'vitest'
import { parseTmuxTitle, TMUX_TITLE } from './tmuxTitle'

describe('parseTmuxTitle', () => {
  it('reads the copy-mode state tmux puts in the title', () => {
    expect(parseTmuxTitle('me-manager:0:')).toEqual({ inCopyMode: false, scrolledBack: 0 })
    expect(parseTmuxTitle('me-manager:1:0')).toEqual({ inCopyMode: true, scrolledBack: 0 })
    expect(parseTmuxTitle('me-manager:1:42')).toEqual({ inCopyMode: true, scrolledBack: 42 })
  })

  it('ignores any other title', () => {
    expect(parseTmuxTitle('✳ Claude Code')).toBeNull()
    expect(parseTmuxTitle('me-manager:x:1')).toBeNull()
    expect(parseTmuxTitle('me-manager:1:2 extra')).toBeNull()
    expect(parseTmuxTitle('')).toBeNull()
  })

  it('is the shape of the format given to tmux', () => {
    expect(TMUX_TITLE).toBe('me-manager:#{pane_in_mode}:#{scroll_position}')
  })
})
