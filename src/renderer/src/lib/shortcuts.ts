export const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

interface KeyLike {
  type?: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Ctrl+Shift+E (Cmd+Shift+E on macOS) toggles the files panel. */
export function isPanelShortcut(e: KeyLike, mac = isMac): boolean {
  if (e.type !== undefined && e.type !== 'keydown') return false
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e'
}

export const PANEL_SHORTCUT_LABEL = isMac ? '⌘⇧E' : 'Ctrl+Shift+E'
