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
 * They avoid keys a terminal needs: new/close tab use Mod+Shift+T / Mod+Shift+W, because Ctrl+T and Ctrl+W
 * mean something to shells and editors running in the terminal. The help overlay is Mod+/ rather than `?`,
 * which would fire while typing.
 */
export type ShortcutId =
  'palette' | 'help' | 'panel' | 'filterSidebar' | 'target' | 'newTab' | 'closeTab' | 'prevTab' | 'nextTab'

/** `target` carries the 0-based position of the task or folder to select (Mod+1 is index 0). */
export type Shortcut = { id: Exclude<ShortcutId, 'target'> } | { id: 'target'; index: number }

interface Binding {
  id: ShortcutId
  /** Whether Shift must be held; 'any' for keys that need Shift on some layouts (e.g. '/' on German). */
  shift: boolean | 'any'
  /** Lowercased `KeyboardEvent.key` values that trigger it. */
  keys: string[]
  /** `KeyboardEvent.code` values that also trigger it. */
  codes?: string[]
  /** The key as shown in labels. */
  display: string
  description: string
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

// Letters match on `key` only, so they follow the user's layout. Digits and brackets also match on `code`,
// for layouts where those keys type something else (AZERTY digits, brackets behind Shift on US: '{').
const BINDINGS: Binding[] = [
  { id: 'palette', shift: false, keys: ['k'], display: 'K', description: 'Command palette' },
  { id: 'help', shift: 'any', keys: ['/', '?'], display: '/', description: 'Keyboard shortcuts' },
  { id: 'panel', shift: true, keys: ['e'], display: 'E', description: 'Toggle files panel' },
  { id: 'filterSidebar', shift: true, keys: ['f'], display: 'F', description: 'Filter the sidebar' },
  {
    id: 'target',
    shift: false,
    keys: DIGITS,
    codes: DIGITS.map((d) => `Digit${d}`),
    display: '1…9',
    description: 'Go to the 1st…9th task or folder in the sidebar',
  },
  { id: 'newTab', shift: true, keys: ['t'], display: 'T', description: 'New shell tab' },
  { id: 'closeTab', shift: true, keys: ['w'], display: 'W', description: 'Close the active tab' },
  { id: 'prevTab', shift: true, keys: ['[', '{'], codes: ['BracketLeft'], display: '[', description: 'Previous tab' },
  { id: 'nextTab', shift: true, keys: [']', '}'], codes: ['BracketRight'], display: ']', description: 'Next tab' },
]

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
  for (const b of BINDINGS) {
    if (b.shift !== 'any' && b.shift !== e.shiftKey) continue
    const byKey = b.keys.indexOf(key)
    const byCode = e.code === undefined || !b.codes ? -1 : b.codes.indexOf(e.code)
    if (byKey === -1 && byCode === -1) continue
    if (b.id === 'target') return { id: 'target', index: byKey !== -1 ? byKey : byCode }
    return { id: b.id as Exclude<ShortcutId, 'target'> }
  }
  return null
}

/** Ctrl+Shift+E (Cmd+Shift+E on macOS) toggles the files panel. */
export function isPanelShortcut(e: KeyLike, mac = isMac): boolean {
  return matchShortcut(e, mac)?.id === 'panel'
}

/** "Ctrl+Shift+E" on Linux, "⌘⇧E" on macOS. */
export function formatKeys(display: string, shift: boolean | 'any', mac = isMac): string {
  const withShift = shift === true
  return mac ? `⌘${withShift ? '⇧' : ''}${display}` : `Ctrl+${withShift ? 'Shift+' : ''}${display}`
}

export function shortcutLabel(id: ShortcutId, mac = isMac): string {
  const b = BINDINGS.find((x) => x.id === id)
  return b ? formatKeys(b.display, b.shift, mac) : ''
}

export interface ShortcutHelpEntry {
  keys: string
  description: string
}

/** Every shortcut, as listed in the help overlay. */
export function shortcutHelp(mac = isMac): ShortcutHelpEntry[] {
  return BINDINGS.map((b) => ({ keys: formatKeys(b.display, b.shift, mac), description: b.description }))
}

export const PANEL_SHORTCUT_LABEL = shortcutLabel('panel')
