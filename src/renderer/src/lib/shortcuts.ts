export const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

export interface KeyLike {
  type?: string
  key: string
  /** The physical key; used as a fallback for punctuation whose `key` depends on the layout. */
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
 * app uses Ctrl+Shift chords there. macOS terminals use Ctrl, not Cmd, so Cmd+K and Cmd+/ are free and work as
 * extra, familiar chords for the palette and the help overlay.
 */
export type ShortcutId =
  'palette' | 'help' | 'settings' | 'panel' | 'filterSidebar' | 'target' | 'newTab' | 'closeTab' | 'prevTab' | 'nextTab'

/** `target` carries the 0-based position of the task or folder to select (Mod+1 is index 0). */
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
}

interface ShortcutDef {
  id: ShortcutId
  description: string
  /** The first chord available on the platform is the one shown in hints and tooltips. */
  chords: Chord[]
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/** A Mod(+Shift)+letter chord, matched on `key` only so it follows the user's layout. */
const letter = (shift: boolean, display: string): Chord => ({ shift, keys: [display.toLowerCase()], display })

// Digits and brackets also match on `code`, for layouts where those keys type something else (AZERTY digits,
// brackets behind Shift on US: '{'). Mod+Shift+/ matches both '/' and '?': with Shift, US layouts report '?',
// and layouts where '/' itself needs Shift (German: Shift+7) report '/'.
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
  {
    id: 'target',
    description: 'Go to the 1st…9th task or folder in the sidebar',
    chords: [{ shift: false, keys: DIGITS, codes: DIGITS.map((d) => `Digit${d}`), display: '1…9' }],
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
]

const chordsFor = (def: ShortcutDef, mac: boolean): Chord[] => def.chords.filter((c) => mac || !c.macOnly)

/**
 * Shortcuts that work while a text field has focus: they don't collide with text editing. All others are
 * ignored in inputs and textareas (the terminal's hidden textarea excepted, see isEditableTarget), so a field
 * keeps its own keys and a stray chord doesn't switch tasks under the user.
 */
const WHILE_TYPING: ReadonlySet<ShortcutId> = new Set(['palette', 'help', 'panel'])

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

/** The app shortcut `e` triggers, or null. Only keydowns count, and never with Alt (AltGr types characters). */
export function matchShortcut(e: KeyLike, mac = isMac): Shortcut | null {
  if (e.type !== undefined && e.type !== 'keydown') return null
  if (!hasMod(e, mac) || e.altKey) return null
  const key = e.key.toLowerCase()
  for (const def of SHORTCUTS) {
    for (const c of chordsFor(def, mac)) {
      if (c.shift !== e.shiftKey) continue
      const byKey = c.keys.indexOf(key)
      const byCode = e.code === undefined || !c.codes ? -1 : c.codes.indexOf(e.code)
      if (byKey === -1 && byCode === -1) continue
      if (def.id === 'target') return { id: 'target', index: byKey !== -1 ? byKey : byCode }
      return { id: def.id as Exclude<ShortcutId, 'target'> }
    }
  }
  return null
}

/** Ctrl+Shift+E (Cmd+Shift+E on macOS) toggles the files panel. */
export function isPanelShortcut(e: KeyLike, mac = isMac): boolean {
  return matchShortcut(e, mac)?.id === 'panel'
}

/** "Ctrl+Shift+E" on Linux, "⌘⇧E" on macOS. */
export function formatKeys(display: string, shift: boolean, mac = isMac): string {
  return mac ? `⌘${shift ? '⇧' : ''}${display}` : `Ctrl+${shift ? 'Shift+' : ''}${display}`
}

/** The shortcut's main chord on this platform, for hints and tooltips. */
export function shortcutLabel(id: ShortcutId, mac = isMac): string {
  const def = SHORTCUTS.find((x) => x.id === id)
  const first = def && chordsFor(def, mac)[0]
  return first ? formatKeys(first.display, first.shift, mac) : ''
}

export interface ShortcutHelpEntry {
  /** Every chord that triggers it on this platform, main one first. */
  keys: string[]
  description: string
}

/** Every shortcut, as listed in the help overlay. */
export function shortcutHelp(mac = isMac): ShortcutHelpEntry[] {
  return SHORTCUTS.map((def) => ({
    keys: chordsFor(def, mac).map((c) => formatKeys(c.display, c.shift, mac)),
    description: def.description,
  }))
}

/** Mod+Enter (Ctrl+Enter on Linux, Cmd+Enter on macOS): submits a multi-line field. */
export function isModEnter(e: KeyLike, mac = isMac): boolean {
  return e.key === 'Enter' && hasMod(e, mac) && !e.altKey && !e.shiftKey
}

export const MOD_ENTER_LABEL = formatKeys('Enter', false)

export const PANEL_SHORTCUT_LABEL = shortcutLabel('panel')
