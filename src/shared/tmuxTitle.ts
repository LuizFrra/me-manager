/**
 * The title tmux gives the app's terminal (set-titles): whether the shown pane is in copy mode, and how many lines it
 * is scrolled back. tmux sends it again whenever it changes, in step with the screen, so the terminal knows when keys
 * would go to copy mode instead of the program without reading it off the screen.
 */
export const TMUX_TITLE = 'me-manager:#{pane_in_mode}:#{scroll_position}'

export interface TmuxMode {
  inCopyMode: boolean
  /** 0 at the bottom (and out of copy mode). */
  scrolledBack: number
}

/** The state in a title made from TMUX_TITLE; null for any other title. */
export function parseTmuxTitle(title: string): TmuxMode | null {
  const m = /^me-manager:(\d+):(\d*)$/.exec(title)
  if (!m) return null
  const inCopyMode = m[1] !== '0'
  return { inCopyMode, scrolledBack: inCopyMode ? Number(m[2] || 0) : 0 }
}
