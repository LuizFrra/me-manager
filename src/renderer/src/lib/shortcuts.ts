export const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export interface KeyLike {
  type?: string
  key: string
  /** The physical key; a fallback for keys whose `key` depends on the layout (see matchShortcut). */
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * The app's keyboard shortcuts. "Mod" is Ctrl on Linux and Cmd on macOS.
 *
 * They avoid keys a terminal needs. On Linux, Ctrl+<letter> and Ctrl+/ reach the shell and Claude Code (Ctrl+K
 * kills to the end of the line, Ctrl+/ is undo, Ctrl+T and Ctrl+W mean something to shells and editors), so the
 * app uses Ctrl+Shift chords there. Ctrl+digits are control codes in a terminal too (Ctrl+3 is ESC, Ctrl+4 is
 * FS/SIGQUIT, then GS, RS, ^_ undo and DEL), so switching tasks is Alt+1..9 on Linux. macOS terminals use Ctrl,
 * not Cmd, so Cmd+1..9, Cmd+K and Cmd+/ are free; the last two are extra, familiar chords for the palette and the
 * help overlay.
 */
export type ShortcutId =
  | 'palette'
  | 'help'
  | 'settings'
  | 'panel'
  | 'filterSidebar'
  | 'searchFiles'
  | 'openEditor'
  | 'usage'
  | 'target'
  | 'newTab'
  | 'closeTab'
  | 'prevTab'
  | 'nextTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'

/** `target` carries the 0-based position of the task or folder to select (Alt+1 / Cmd+1 is index 0). */
export type Shortcut = { id: Exclude<ShortcutId, 'target'> } | { id: 'target'; index: number }

/** One key combination that triggers a shortcut, on top of Mod. */
interface Chord {
  /** Whether Shift must be held. */
  shift: boolean
  /** Lowercased `KeyboardEvent.key` values that trigger it. */
  keys: string[]
  /** `KeyboardEvent.code` values that also trigger it. */
  codes?: string[]
  /** The key as shown in labels. */
  display: string
  /** Only on macOS, where Cmd chords don't collide with the terminal's Ctrl keys. */
  macOnly?: true
  /** Shift is only how the layout types the key (Shift+= is '+'), so labels show "Mod++", not "Mod+Shift++". */
  shiftImplied?: true
  /** Held with Alt instead of Ctrl on Linux (Cmd on macOS, as usual). */
  linuxAlt?: true
}

interface ShortcutDef {
  id: ShortcutId
  description: string
  /** The first chord available on the platform is the one shown in hints and tooltips. */
  chords: Chord[]
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * A Mod(+Shift)+letter chord. It matches on `key`, so it follows the user's Latin layout (Dvorak, AZERTY…), and on
 * the physical key only when `key` isn't a Latin letter at all (Russian, Greek, Hebrew… layouts).
 */
const letter = (shift: boolean, display: string): Chord => ({
  shift,
  keys: [display.toLowerCase()],
  codes: [`Key${display}`],
  display,
})

// Digits and brackets also match on `code`, for layouts where those keys type something else (AZERTY digits,
// brackets behind Shift on US: '{'); see matchShortcut for when `code` counts. Mod+Shift+/ matches both '/' and
// '?': with Shift, US layouts report '?', and layouts where '/' itself needs Shift (German: Shift+7) report '/'.
const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'palette',
    description: 'Command palette',
    chords: [{ ...letter(false, 'K'), macOnly: true }, letter(true, 'P')],
  },
  {
    id: 'help',
    description: 'Keyboard shortcuts',
    chords: [
      { shift: false, keys: ['/'], display: '/', macOnly: true },
      { shift: true, keys: ['/', '?'], display: '/' },
    ],
  },
  // Mod+, is the usual "preferences" chord on both platforms; Ctrl+, means nothing to a terminal.
  { id: 'settings', description: 'Settings', chords: [{ shift: false, keys: [','], codes: ['Comma'], display: ',' }] },
  { id: 'panel', description: 'Toggle files panel', chords: [letter(true, 'E')] },
  { id: 'filterSidebar', description: 'Filter the sidebar', chords: [letter(true, 'F')] },
  // Mod+Shift+F (the usual "find in files") already filters the sidebar; S for Search. Free in shells and Claude
  // Code on Linux (Ctrl+Shift chords), and macOS has no File menu whose Cmd+Shift+S ("Save As") it would shadow.
  { id: 'searchFiles', description: 'Search in files', chords: [letter(true, 'S')] },
  { id: 'openEditor', description: 'Open in editor', chords: [letter(true, 'O')] },
  { id: 'usage', description: 'Claude usage and cost', chords: [letter(true, 'U')] },
  {
    id: 'target',
    description: 'Go to the 1st…9th task or folder in the sidebar',
    chords: [{ shift: false, keys: DIGITS, codes: DIGITS.map((d) => `Digit${d}`), display: '1…9', linuxAlt: true }],
  },
  { id: 'newTab', description: 'New shell tab', chords: [letter(true, 'T')] },
  { id: 'closeTab', description: 'Close the active tab', chords: [letter(true, 'W')] },
  {
    id: 'prevTab',
    description: 'Previous tab',
    chords: [{ shift: true, keys: ['[', '{'], codes: ['BracketLeft'], display: '[' }],
  },
  {
    id: 'nextTab',
    description: 'Next tab',
    chords: [{ shift: true, keys: [']', '}'], codes: ['BracketRight'], display: ']' }],
  },
  // Terminal zoom. Mod+= and Mod++ both zoom in: '+' is Shift+= on US layouts but a key of its own elsewhere
  // (German), and the keypad has one too. On Linux, Ctrl+= / Ctrl+- / Ctrl+0 mean nothing to common shells.
  {
    id: 'zoomIn',
    description: 'Terminal: larger font',
    chords: [
      { shift: false, keys: ['=', '+'], codes: ['Equal', 'NumpadAdd'], display: '=' },
      { shift: true, keys: ['+', '='], codes: ['Equal'], display: '+', shiftImplied: true },
    ],
  },
  {
    id: 'zoomOut',
    description: 'Terminal: smaller font',
    chords: [{ shift: false, keys: ['-'], codes: ['Minus', 'NumpadSubtract'], display: '-' }],
  },
  {
    id: 'zoomReset',
    description: 'Terminal: reset the font size',
    chords: [{ shift: false, keys: ['0'], codes: ['Digit0', 'Numpad0'], display: '0' }],
  },
]

const chordsFor = (def: ShortcutDef, mac: boolean): Chord[] => def.chords.filter((c) => mac || !c.macOnly)

/**
 * Shortcuts that work while a text field has focus: they don't collide with text editing. All others are
 * ignored in inputs and textareas (the terminal's hidden textarea excepted, see isEditableTarget), so a field
 * keeps its own keys and a stray chord doesn't switch tasks under the user.
 */
const WHILE_TYPING: ReadonlySet<ShortcutId> = new Set(['palette', 'help', 'usage', 'panel', 'searchFiles'])

export const worksWhileTyping = (id: ShortcutId): boolean => WHILE_TYPING.has(id)

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'])

/** True for a focused text field (input, textarea, select, contenteditable) other than the terminal's. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  // xterm takes keyboard input through a hidden textarea: that is the terminal, not a text field.
  if (target.closest('.xterm')) return false
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type)
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

const hasMod = (e: KeyLike, mac: boolean): boolean => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)

/**
 * Whether `e` holds exactly the chord's modifier: Cmd on macOS; Ctrl on Linux, or Alt for a `linuxAlt` chord.
 * Alt never counts on top of Ctrl or Cmd (AltGr types characters).
 */
function holdsModifier(e: KeyLike, c: Chord, mac: boolean): boolean {
  if (mac) return e.metaKey && !e.ctrlKey && !e.altKey
  if (c.linuxAlt) return e.altKey && !e.ctrlKey && !e.metaKey
  return e.ctrlKey && !e.metaKey && !e.altKey
}

/** Characters a zoom shortcut is typed with: on a digit key (AZERTY's '-' is on 6), they are not a digit. */
const ZOOM_KEYS = new Set(['=', '+', '-'])

/**
 * Whether the physical key `code` may stand in for `key`, which no chord matched: a letter key only when `key`
 * isn't a Latin letter (a non-Latin layout), a digit key only when `key` is neither a digit nor a zoom character.
 * Punctuation keys (comma, brackets, the keypad) always may.
 */
function codeMayStandIn(code: string, key: string): boolean {
  if (code.startsWith('Key')) return !/^[a-z]$/.test(key)
  if (code.startsWith('Digit')) return !/^[0-9]$/.test(key) && !ZOOM_KEYS.has(key)
  return true
}

const toShortcut = (def: ShortcutDef, index: number): Shortcut =>
  def.id === 'target' ? { id: 'target', index } : { id: def.id }

/**
 * The app shortcut `e` triggers, or null. Only keydowns count. What the key types (`key`) is matched first, across
 * every shortcut, so Mod+- on AZERTY (the 6 key) zooms out rather than going to the 6th task; the physical key
 * (`code`) is a fallback, see codeMayStandIn.
 */
export function matchShortcut(e: KeyLike, mac = isMac): Shortcut | null {
  if (e.type !== undefined && e.type !== 'keydown') return null
  const key = e.key.toLowerCase()
  const candidates = SHORTCUTS.flatMap((def) =>
    chordsFor(def, mac)
      .filter((c) => c.shift === e.shiftKey && holdsModifier(e, c, mac))
      .map((c) => ({ def, c })),
  )
  for (const { def, c } of candidates) {
    const index = c.keys.indexOf(key)
    if (index !== -1) return toShortcut(def, index)
  }
  const { code } = e
  if (code === undefined || !codeMayStandIn(code, key)) return null
  for (const { def, c } of candidates) {
    const index = c.codes?.indexOf(code) ?? -1
    if (index !== -1) return toShortcut(def, index)
  }
  return null
}

/** Ctrl+Shift+E (Cmd+Shift+E on macOS) toggles the files panel. */
export function isPanelShortcut(e: KeyLike, mac = isMac): boolean {
  return matchShortcut(e, mac)?.id === 'panel'
}

/** "Ctrl+Shift+E" (or "Alt+Shift+E" with `alt`) on Linux, "⌘⇧E" on macOS. */
export function formatKeys(display: string, shift: boolean, mac = isMac, alt = false): string {
  return mac ? `⌘${shift ? '⇧' : ''}${display}` : `${alt ? 'Alt' : 'Ctrl'}+${shift ? 'Shift+' : ''}${display}`
}

const chordLabel = (c: Chord, mac: boolean): string =>
  formatKeys(c.display, c.shift && !c.shiftImplied, mac, c.linuxAlt === true)

/** The shortcut's main chord on this platform, for hints and tooltips. */
export function shortcutLabel(id: ShortcutId, mac = isMac): string {
  const def = SHORTCUTS.find((x) => x.id === id)
  const first = def && chordsFor(def, mac)[0]
  return first ? chordLabel(first, mac) : ''
}

export interface ShortcutHelpEntry {
  /** Every chord that triggers it on this platform, main one first. */
  keys: string[]
  description: string
}

/**
 * The keys of the code view's and the diff's line numbers when they have focus (see lib/lineSelection.ts): plain
 * keys, so not app shortcuts; listed in the help overlay after them.
 */
export const REVIEW_HELP: readonly ShortcutHelpEntry[] = [
  { keys: ['↑ ↓', 'Shift+↑ ↓'], description: 'Line numbers: select lines, extend the selection' },
  { keys: ['C', 'Enter'], description: 'Line numbers: comment on the selected lines' },
  { keys: ['Esc'], description: 'Line numbers: clear the selection' },
]

/**
 * Alt+Shift+↑ / ↓ (Option+Shift on macOS) on a focused sidebar row moves the theme, repo, folder or task up (-1) or
 * down (1) among its siblings; 0 for any other key. Only the row's own keydown counts, so it never reaches the
 * terminal, where the chord means something to the shell.
 */
export function rowMoveStep(e: KeyLike): -1 | 0 | 1 {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return 0
  return e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
}

/** rowMoveStep's keys, for the help overlay. */
const rowMoveHelp = (mac: boolean): ShortcutHelpEntry => ({
  keys: [mac ? '⌥⇧↑ ↓' : 'Alt+Shift+↑ ↓'],
  description: 'Sidebar: move the focused row up or down',
})

/**
 * Shift+↑ / ↓ on a focused task row extends the multi-selection to the task above (-1) or below (1) in its repo; 0
 * for any other key, or with Alt (rowMoveStep), Ctrl or Cmd held too.
 */
export function rowExtendStep(e: KeyLike): -1 | 0 | 1 {
  if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return 0
  return e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
}

/** What a click on a task row does to the multi-selection, by its modifiers. */
export type SelectMode = 'toggle' | 'range' | 'addRange'

/**
 * Mod+click (Ctrl on Linux, Cmd on macOS, where Ctrl+click is a right click) toggles a task in or out, Shift+click
 * selects a range, Mod+Shift+click adds one; null for a plain click (it opens the task), or with Alt.
 */
export function clickSelectMode(
  e: Pick<KeyLike, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  mac = isMac,
): SelectMode | null {
  if (e.altKey || (mac ? e.ctrlKey : e.metaKey)) return null
  const mod = mac ? e.metaKey : e.ctrlKey
  if (e.shiftKey) return mod ? 'addRange' : 'range'
  return mod ? 'toggle' : null
}

/** The multi-selection's keys, for the help overlay. */
const selectionHelp = (mac: boolean): ShortcutHelpEntry[] => [
  {
    keys: mac ? ['⌘-click', '⇧-click'] : ['Ctrl+click', 'Shift+click'],
    description: 'Sidebar: select several tasks, or a range in a repo',
  },
  {
    keys: ['Space', mac ? '⇧↑ ↓' : 'Shift+↑ ↓'],
    description: 'Sidebar: add the focused task to the selection, or extend it',
  },
  { keys: ['Esc'], description: 'Sidebar: clear the task selection' },
]

/**
 * Every shortcut, as listed in the help overlay, then the sidebar rows' keys and the line numbers' (REVIEW_HELP).
 */
export function shortcutHelp(mac = isMac): ShortcutHelpEntry[] {
  const app = SHORTCUTS.map((def) => ({
    keys: chordsFor(def, mac).map((c) => chordLabel(c, mac)),
    description: def.description,
  }))
  return [...app, rowMoveHelp(mac), ...selectionHelp(mac), ...REVIEW_HELP]
}

/** Mod+Enter (Ctrl+Enter on Linux, Cmd+Enter on macOS): submits a multi-line field. */
export function isModEnter(e: KeyLike, mac = isMac): boolean {
  return e.key === 'Enter' && hasMod(e, mac) && !e.altKey && !e.shiftKey
}

export const MOD_ENTER_LABEL = formatKeys('Enter', false)

export const PANEL_SHORTCUT_LABEL = shortcutLabel('panel')
