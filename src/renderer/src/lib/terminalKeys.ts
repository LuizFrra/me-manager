/**
 * What the terminal does itself with a key, instead of sending it to tmux:
 * - `copy`: copy the selection (Ctrl+Shift+C, Ctrl+Insert);
 * - `copyOrInterrupt`: copy when something is selected, else the key goes on as ^C (Ctrl+C);
 * - `paste`: paste the clipboard's text (Ctrl+Shift+V, Shift+Insert);
 * - `pasteOrImage`: paste the clipboard's text, or send ^V when it holds none, so Claude Code pastes the image
 *   that is there (Ctrl+V);
 * - `newline`: a new line in Claude's prompt instead of submitting it (Shift+Enter sends Meta+Enter, which Claude
 *   Code reads as a newline).
 *
 * On macOS the Edit menu owns Cmd+C and Cmd+V, and Ctrl+C / Ctrl+V stay terminal keys.
 */
export type TerminalKeyAction = 'copy' | 'copyOrInterrupt' | 'paste' | 'pasteOrImage' | 'newline'

/** What Shift+Enter sends: ESC CR, i.e. Meta+Enter. */
export const NEWLINE_SEQUENCE = '\x1b\r'
/** ^V, which Claude Code takes as "paste the image on the clipboard". */
export const PASTE_IMAGE_SEQUENCE = '\x16'

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/**
 * The letter a key types for shortcuts: `e.key` on a Latin layout, else the physical key (`KeyC`), so Ctrl+C
 * still copies on a Cyrillic or Greek layout while Dvorak's own letters are kept.
 */
function letter(e: KeyLike): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : ''
}

export function terminalKeyAction(e: KeyLike, mac: boolean): TerminalKeyAction | null {
  if (e.altKey || e.metaKey) return null
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey) return 'newline'
  if (mac) return null
  if (e.key === 'Insert') {
    if (e.ctrlKey && !e.shiftKey) return 'copy'
    if (e.shiftKey && !e.ctrlKey) return 'paste'
    return null
  }
  if (!e.ctrlKey) return null
  const l = letter(e)
  if (l === 'c') return e.shiftKey ? 'copy' : 'copyOrInterrupt'
  if (l === 'v') return e.shiftKey ? 'paste' : 'pasteOrImage'
  return null
}
