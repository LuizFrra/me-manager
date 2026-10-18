import { describe, expect, it } from 'vitest'
import { isPanelShortcut, matchShortcut, shortcutHelp, shortcutLabel } from './shortcuts'

const key = (over: Partial<Parameters<typeof isPanelShortcut>[0]>): Parameters<typeof isPanelShortcut>[0] => ({
  type: 'keydown',
  key: 'E',
  ctrlKey: false,
  metaKey: false,
  shiftKey: true,
  altKey: false,
  ...over,
})

describe('isPanelShortcut', () => {
  it('is Ctrl+Shift+E on Linux', () => {
    expect(isPanelShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isPanelShortcut(key({ ctrlKey: true, key: 'e' }), false)).toBe(true)
    expect(isPanelShortcut(key({ metaKey: true }), false)).toBe(false)
  })

  it('is Cmd+Shift+E on macOS', () => {
    expect(isPanelShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isPanelShortcut(key({ ctrlKey: true }), true)).toBe(false)
  })

  it('needs shift, no alt, the E key and a keydown', () => {
    expect(isPanelShortcut(key({ ctrlKey: true, shiftKey: false }), false)).toBe(false)
    expect(isPanelShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isPanelShortcut(key({ ctrlKey: true, key: 'R' }), false)).toBe(false)
    expect(isPanelShortcut(key({ ctrlKey: true, type: 'keyup' }), false)).toBe(false)
  })
})

describe('matchShortcut', () => {
  const mod = (mac: boolean, over: Partial<Parameters<typeof isPanelShortcut>[0]>): ReturnType<typeof key> =>
    key({ shiftKey: false, ...(mac ? { metaKey: true } : { ctrlKey: true }), ...over })

  it('is Ctrl+K on Linux and Cmd+K on macOS for the palette', () => {
    expect(matchShortcut(mod(false, { key: 'k' }), false)).toEqual({ id: 'palette' })
    expect(matchShortcut(mod(true, { key: 'k' }), true)).toEqual({ id: 'palette' })
    expect(matchShortcut(mod(true, { key: 'k' }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'k' }), true)).toBeNull()
  })

  it('needs exactly the modifier: no Alt, no extra Shift, no plain key', () => {
    expect(matchShortcut(mod(false, { key: 'k', altKey: true }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'K', shiftKey: true }), false)).toBeNull()
    expect(matchShortcut(key({ key: 'k', shiftKey: false }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'k', ctrlKey: true, metaKey: true }), false)).toBeNull()
  })

  it('matches the panel toggle too', () => {
    expect(matchShortcut(mod(false, { key: 'E', shiftKey: true }), false)).toEqual({ id: 'panel' })
  })
})

describe('shortcut labels', () => {
  it('uses Ctrl on Linux and ⌘ on macOS', () => {
    expect(shortcutLabel('palette', false)).toBe('Ctrl+K')
    expect(shortcutLabel('palette', true)).toBe('⌘K')
    expect(shortcutLabel('panel', false)).toBe('Ctrl+Shift+E')
    expect(shortcutLabel('panel', true)).toBe('⌘⇧E')
  })

  it('lists every shortcut for the help overlay', () => {
    expect(shortcutHelp(false)).toContainEqual({ keys: 'Ctrl+K', description: 'Command palette' })
    expect(shortcutHelp(true)).toContainEqual({ keys: '⌘⇧E', description: 'Toggle files panel' })
  })
})
