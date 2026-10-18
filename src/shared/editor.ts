/**
 * Editors that need a terminal to run in. The app starts editors detached, with no terminal, so these can't
 * work and are skipped (auto-detection) or refused (Settings). The rule, kept simple on purpose:
 * - the command's basename is one of TERMINAL_EDITORS; or
 * - it is emacs or emacsclient with a terminal flag (-nw, -t, --tty, --no-window-system). Plain emacs opens
 *   a GUI window, so it is fine.
 * GUI variants (gvim, nvim-qt, …) have other names and pass.
 */
export const TERMINAL_EDITORS: ReadonlySet<string> = new Set([
  'vi',
  'vim',
  'view',
  'nvim',
  'nano',
  'pico',
  'micro',
  'hx',
  'helix',
  'kak',
  'joe',
  'jed',
  'mg',
  'ne',
  'ed',
  'ex',
])

const EMACS = new Set(['emacs', 'emacsclient'])
const EMACS_TERMINAL_FLAGS = new Set(['-nw', '-t', '--tty', '--no-window-system'])

export const commandBasename = (file: string): string => file.split(/[\\/]/).pop() ?? file

/** `argv` is a split command line: [file, ...args]. */
export function isTerminalEditor(argv: readonly string[]): boolean {
  if (argv.length === 0) return false
  const name = commandBasename(argv[0])
  if (TERMINAL_EDITORS.has(name)) return true
  return EMACS.has(name) && argv.slice(1).some((a) => EMACS_TERMINAL_FLAGS.has(a))
}
