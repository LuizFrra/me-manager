import type { IClipboardProvider } from '@xterm/addon-clipboard'

export interface ClipboardSinks {
  /** Writes the system clipboard. */
  write: (text: string) => Promise<void>
  /** Keeps a mouse selection made in tmux, for an explicit copy (Cmd+C, Ctrl+Shift+C) to write later. */
  hold: (text: string) => void
}

/**
 * OSC 52 clipboard provider that is write-only: programs in the pty may set the
 * system clipboard but can never read it.
 *
 * tmux sends its own copies (a mouse drag, or a double-click on a word, in its
 * copy mode) with an empty selection (`\x1b]52;;<base64>\x07`). Those are held,
 * not written: a click with a slight drag would otherwise replace the clipboard
 * with a character or two, and Cmd+V would paste that. A program that copies on
 * purpose (Claude Code's /copy) names the clipboard (`c`), which tmux passes on,
 * so that is written. The X11 primary selection (`p`) alone is ignored.
 */
export function createWriteOnlyClipboard({ write, hold }: ClipboardSinks): IClipboardProvider {
  return {
    readText: () => '',
    writeText: async (selection, text) => {
      const sel = selection as string
      if (sel === '') hold(text)
      else if (sel.includes('c')) await write(text)
    },
  }
}
