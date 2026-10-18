import { describe, expect, it } from 'vitest'
import {
  isEditableTarget,
  isPanelShortcut,
  matchShortcut,
  shortcutHelp,
  shortcutLabel,
  worksWhileTyping,
} from './shortcuts'

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
    expect(shortcutHelp(false)).toEqual([
      { keys: 'Ctrl+K', description: 'Command palette' },
      { keys: 'Ctrl+/', description: 'Keyboard shortcuts' },
      { keys: 'Ctrl+Shift+E', description: 'Toggle files panel' },
      { keys: 'Ctrl+1…9', description: 'Go to the 1st…9th task or folder in the sidebar' },
      { keys: 'Ctrl+Shift+T', description: 'New shell tab' },
      { keys: 'Ctrl+Shift+W', description: 'Close the active tab' },
      { keys: 'Ctrl+Shift+[', description: 'Previous tab' },
      { keys: 'Ctrl+Shift+]', description: 'Next tab' },
    ])
    expect(shortcutHelp(true).map((e) => e.keys)).toEqual(['⌘K', '⌘/', '⌘⇧E', '⌘1…9', '⌘⇧T', '⌘⇧W', '⌘⇧[', '⌘⇧]'])
  })
})

describe.each([
  { platform: 'Linux', mac: false, mod: { ctrlKey: true }, wrongMod: { metaKey: true } },
  { platform: 'macOS', mac: true, mod: { metaKey: true }, wrongMod: { ctrlKey: true } },
])('matchShortcut on $platform', ({ mac, mod, wrongMod }) => {
  const press = (
    k: string,
    over: Partial<Parameters<typeof matchShortcut>[0]> = {},
  ): ReturnType<typeof matchShortcut> => matchShortcut(key({ key: k, shiftKey: false, ...mod, ...over }), mac)
  const shifted = (
    k: string,
    over: Partial<Parameters<typeof matchShortcut>[0]> = {},
  ): ReturnType<typeof matchShortcut> => press(k, { shiftKey: true, ...over })

  it('selects the Nth target with Mod+1..9', () => {
    expect(press('1')).toEqual({ id: 'target', index: 0 })
    expect(press('2')).toEqual({ id: 'target', index: 1 })
    expect(press('9')).toEqual({ id: 'target', index: 8 })
    expect(press('0')).toBeNull()
    expect(shifted('!', { code: 'Digit1' })).toBeNull()
  })

  it('reads the digit from the physical key on layouts where it types a symbol (AZERTY)', () => {
    expect(press('&', { code: 'Digit1' })).toEqual({ id: 'target', index: 0 })
    expect(press('é', { code: 'Digit2' })).toEqual({ id: 'target', index: 1 })
  })

  it('uses the Shift variants for tabs, never plain Mod+T / Mod+W', () => {
    expect(shifted('T')).toEqual({ id: 'newTab' })
    expect(shifted('W')).toEqual({ id: 'closeTab' })
    expect(press('t')).toBeNull()
    expect(press('w')).toBeNull()
  })

  it('switches tabs with Mod+Shift+[ and Mod+Shift+], whatever the bracket key types with Shift', () => {
    expect(shifted('{', { code: 'BracketLeft' })).toEqual({ id: 'prevTab' })
    expect(shifted('}', { code: 'BracketRight' })).toEqual({ id: 'nextTab' })
    expect(shifted('[')).toEqual({ id: 'prevTab' })
    expect(shifted(']')).toEqual({ id: 'nextTab' })
    expect(press('[', { code: 'BracketLeft' })).toBeNull()
  })

  it('toggles help with Mod+/, also where / needs Shift', () => {
    expect(press('/')).toEqual({ id: 'help' })
    expect(shifted('/', { code: 'Digit7' })).toEqual({ id: 'help' })
    expect(shifted('?')).toEqual({ id: 'help' })
  })

  it('opens the palette and toggles the panel', () => {
    expect(press('k')).toEqual({ id: 'palette' })
    expect(shifted('E')).toEqual({ id: 'panel' })
  })

  it("ignores the other platform's modifier, Alt, both modifiers and keyups", () => {
    for (const k of ['1', 'k', '/']) {
      expect(matchShortcut(key({ key: k, shiftKey: false, ...wrongMod }), mac)).toBeNull()
      expect(press(k, { altKey: true })).toBeNull()
      expect(press(k, { ctrlKey: true, metaKey: true })).toBeNull()
      expect(press(k, { type: 'keyup' })).toBeNull()
    }
    expect(matchShortcut(key({ key: 'T', ...wrongMod }), mac)).toBeNull()
  })
})

describe('worksWhileTyping', () => {
  it('lets only the palette, help and panel toggles through in text fields', () => {
    expect(worksWhileTyping('palette')).toBe(true)
    expect(worksWhileTyping('help')).toBe(true)
    expect(worksWhileTyping('panel')).toBe(true)
    for (const id of ['target', 'newTab', 'closeTab', 'prevTab', 'nextTab'] as const)
      expect(worksWhileTyping(id)).toBe(false)
  })
})

describe('isEditableTarget', () => {
  const make = (html: string): HTMLElement => {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host)
    return host.querySelector('[data-t]') ?? host
  }

  it('is true for text inputs, textareas, selects and contenteditable', () => {
    expect(isEditableTarget(make('<input data-t>'))).toBe(true)
    expect(isEditableTarget(make('<input type="search" data-t>'))).toBe(true)
    expect(isEditableTarget(make('<textarea data-t></textarea>'))).toBe(true)
    expect(isEditableTarget(make('<select data-t></select>'))).toBe(true)
    expect(isEditableTarget(make('<div contenteditable="true"><span data-t>x</span></div>'))).toBe(true)
  })

  it("is false for the terminal's hidden textarea, buttons, checkboxes and the window", () => {
    expect(
      isEditableTarget(make('<div class="xterm"><textarea class="xterm-helper-textarea" data-t></textarea></div>')),
    ).toBe(false)
    expect(isEditableTarget(make('<button data-t>x</button>'))).toBe(false)
    expect(isEditableTarget(make('<input type="checkbox" data-t>'))).toBe(false)
    expect(isEditableTarget(make('<div contenteditable="false"><span data-t>x</span></div>'))).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
