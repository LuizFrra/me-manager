import type { IClipboardProvider } from '@xterm/addon-clipboard'

/**
 * OSC 52 clipboard provider that is write-only: programs in the pty may set the
 * system clipboard but can never read it.
 *
 * tmux sends an empty selection (`\x1b]52;;<base64>\x07`), which by the OSC 52
 * spec means the default selection ("s0", i.e. the clipboard), so it is written
 * too. The X11 primary selection (`p`) alone is ignored.
 */
export function createWriteOnlyClipboard(writeText: (text: string) => Promise<void>): IClipboardProvider {
  return {
    readText: () => '',
    writeText: async (selection, text) => {
      const sel = selection as string
      if (sel === '' || sel.includes('c')) await writeText(text)
    },
  }
}
