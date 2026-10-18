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

/** The app's keyboard shortcuts. "Mod" is Ctrl on Linux and Cmd on macOS. */
export type ShortcutId = 'palette' | 'panel'

export interface Shortcut {
  id: ShortcutId
}

interface Binding {
  id: ShortcutId
  shift: boolean
  /** Lowercased `KeyboardEvent.key` values that trigger it. */
  keys: string[]
  /** `KeyboardEvent.code` values that also trigger it. */
  codes?: string[]
  /** The key as shown in labels. */
  display: string
  description: string
}

const BINDINGS: Binding[] = [
  { id: 'palette', shift: false, keys: ['k'], display: 'K', description: 'Command palette' },
  { id: 'panel', shift: true, keys: ['e'], display: 'E', description: 'Toggle files panel' },
]

const hasMod = (e: KeyLike, mac: boolean): boolean => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)

/** The app shortcut `e` triggers, or null. Only keydowns count, and never with Alt (AltGr types characters). */
export function matchShortcut(e: KeyLike, mac = isMac): Shortcut | null {
  if (e.type !== undefined && e.type !== 'keydown') return null
  if (!hasMod(e, mac) || e.altKey) return null
  const key = e.key.toLowerCase()
  for (const b of BINDINGS) {
    if (b.shift !== e.shiftKey) continue
    if (b.keys.includes(key) || (e.code !== undefined && b.codes?.includes(e.code))) return { id: b.id }
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
