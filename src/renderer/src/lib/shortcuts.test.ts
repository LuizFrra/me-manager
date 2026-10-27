import { describe, expect, it } from 'vitest'
import {
  actsOnRepeat,
  clickSelectMode,
  isEditableTarget,
  isModEnter,
  isPanelShortcut,
  matchShortcut,
  REVIEW_HELP,
  rowExtendStep,
  rowMoveStep,
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

  it('is Ctrl+Shift+P on Linux, and Cmd+Shift+P or Cmd+K on macOS, for the palette', () => {
    expect(matchShortcut(mod(false, { key: 'P', shiftKey: true }), false)).toEqual({ id: 'palette' })
    expect(matchShortcut(mod(true, { key: 'p', shiftKey: true }), true)).toEqual({ id: 'palette' })
    expect(matchShortcut(mod(true, { key: 'k' }), true)).toEqual({ id: 'palette' })
    expect(matchShortcut(mod(true, { key: 'k' }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'P', shiftKey: true }), true)).toBeNull()
  })

  it('leaves Ctrl+K and Ctrl+/ to the terminal on Linux (kill line, undo)', () => {
    expect(matchShortcut(mod(false, { key: 'k' }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: '/' }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'p' }), false)).toBeNull()
  })

  it('needs exactly the modifier: no Alt, no extra Shift, no plain key', () => {
    expect(matchShortcut(mod(true, { key: 'k', altKey: true }), true)).toBeNull()
    expect(matchShortcut(mod(true, { key: 'K', shiftKey: true }), true)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'P', shiftKey: true, altKey: true }), false)).toBeNull()
    expect(matchShortcut(key({ key: 'P', shiftKey: true }), false)).toBeNull()
    expect(matchShortcut(mod(false, { key: 'P', shiftKey: true, metaKey: true }), false)).toBeNull()
  })

  it('matches the panel toggle too', () => {
    expect(matchShortcut(mod(false, { key: 'E', shiftKey: true }), false)).toEqual({ id: 'panel' })
  })

  it('is Mod+Shift+S for "Search in files", which also works while typing; Ctrl+S stays with the terminal', () => {
    expect(matchShortcut(mod(false, { key: 'S', shiftKey: true }), false)).toEqual({ id: 'searchFiles' })
    expect(matchShortcut(mod(true, { key: 's', shiftKey: true }), true)).toEqual({ id: 'searchFiles' })
    expect(matchShortcut(mod(false, { key: 's' }), false)).toBeNull()
    expect(worksWhileTyping('searchFiles')).toBe(true)
    expect(shortcutLabel('searchFiles', false)).toBe('Ctrl+Shift+S')
  })
})

describe('shortcut labels', () => {
  it('uses Ctrl on Linux and ⌘ on macOS', () => {
    expect(shortcutLabel('palette', false)).toBe('Ctrl+Shift+P')
    expect(shortcutLabel('palette', true)).toBe('⌘K')
    expect(shortcutLabel('help', false)).toBe('Ctrl+Shift+/')
    expect(shortcutLabel('help', true)).toBe('⌘/')
    expect(shortcutLabel('panel', false)).toBe('Ctrl+Shift+E')
    expect(shortcutLabel('panel', true)).toBe('⌘⇧E')
  })

  it('lists every shortcut for the help overlay', () => {
    expect(shortcutHelp(false)).toEqual([
      { keys: ['Ctrl+Shift+P'], description: 'Command palette' },
      { keys: ['Ctrl+Shift+/'], description: 'Keyboard shortcuts' },
      { keys: ['Ctrl+,'], description: 'Settings' },
      { keys: ['Ctrl+Shift+E'], description: 'Toggle files panel' },
      { keys: ['Ctrl+Shift+F'], description: 'Filter the sidebar' },
      { keys: ['Ctrl+Shift+S'], description: 'Search in files' },
      { keys: ['Ctrl+Shift+O'], description: 'Open in editor' },
      { keys: ['Ctrl+Shift+U'], description: 'Claude usage and cost' },
      { keys: ['Ctrl+Shift+N'], description: 'New task' },
      { keys: ['Ctrl+Shift+B'], description: 'Show or hide the sidebar' },
      { keys: ['Alt+1…9'], description: 'Go to the 1st…9th task or folder in the sidebar' },
      { keys: ['Ctrl+Shift+T'], description: 'New shell tab' },
      { keys: ['Ctrl+Shift+W'], description: 'Close the active tab' },
      { keys: ['Ctrl+Shift+['], description: 'Previous tab' },
      { keys: ['Ctrl+Shift+]'], description: 'Next tab' },
      { keys: ['Ctrl+=', 'Ctrl++'], description: 'Terminal: larger font' },
      { keys: ['Ctrl+-'], description: 'Terminal: smaller font' },
      { keys: ['Ctrl+0'], description: 'Terminal: reset the font size' },
      { keys: ['↑ ↓', 'Home End'], description: 'Sidebar: go to the row above or below, the first or the last' },
      { keys: ['← →'], description: 'Sidebar: collapse or expand the focused row, go up or in' },
      { keys: ['Alt+Shift+↑ ↓'], description: 'Sidebar: move the focused row up or down' },
      { keys: ['Ctrl+click', 'Shift+click'], description: 'Sidebar: select several tasks, or a range in a repo' },
      { keys: ['Space', 'Shift+↑ ↓'], description: 'Sidebar: add the focused task to the selection, or extend it' },
      { keys: ['Esc'], description: 'Sidebar: clear the task selection' },
      ...REVIEW_HELP,
    ])
    expect(shortcutHelp(true).map((e) => e.keys)).toEqual([
      ['⌘K', '⌘⇧P'],
      ['⌘/', '⌘⇧/'],
      ['⌘,'],
      ['⌘⇧E'],
      ['⌘⇧F'],
      ['⌘⇧S'],
      ['⌘⇧O'],
      ['⌘⇧U'],
      ['⌘⇧N'],
      ['⌘⇧B'],
      ['⌘1…9'],
      ['⌘⇧T'],
      ['⌘⇧W'],
      ['⌘⇧['],
      ['⌘⇧]'],
      ['⌘=', '⌘+'],
      ['⌘-'],
      ['⌘0'],
      ['↑ ↓', 'Home End'],
      ['← →'],
      ['⌥⇧↑ ↓'],
      ['⌘-click', '⇧-click'],
      ['Space', '⇧↑ ↓'],
      ['Esc'],
      ...REVIEW_HELP.map((e) => e.keys),
    ])
  })

  it('ends with the review keys of the focused line numbers, the same everywhere', () => {
    expect(REVIEW_HELP).toEqual([
      { keys: ['↑ ↓', 'Shift+↑ ↓'], description: 'Line numbers: select lines, extend the selection' },
      { keys: ['C', 'Enter'], description: 'Line numbers: comment on the selected lines' },
      { keys: ['Esc'], description: 'Line numbers: clear the selection' },
    ])
  })
})

describe.each([
  {
    platform: 'Linux',
    mac: false,
    mod: { ctrlKey: true },
    wrongMod: { metaKey: true },
    digitMod: { altKey: true },
  },
  { platform: 'macOS', mac: true, mod: { metaKey: true }, wrongMod: { ctrlKey: true }, digitMod: { metaKey: true } },
])('matchShortcut on $platform', ({ mac, mod, wrongMod, digitMod }) => {
  const press = (
    k: string,
    over: Partial<Parameters<typeof matchShortcut>[0]> = {},
  ): ReturnType<typeof matchShortcut> => matchShortcut(key({ key: k, shiftKey: false, ...mod, ...over }), mac)
  const shifted = (
    k: string,
    over: Partial<Parameters<typeof matchShortcut>[0]> = {},
  ): ReturnType<typeof matchShortcut> => press(k, { shiftKey: true, ...over })

  /** A digit chord: Alt+digit on Linux, Cmd+digit on macOS. */
  const digit = (
    k: string,
    over: Partial<Parameters<typeof matchShortcut>[0]> = {},
  ): ReturnType<typeof matchShortcut> => matchShortcut(key({ key: k, shiftKey: false, ...digitMod, ...over }), mac)

  it('selects the Nth target with Alt+1..9 on Linux and Cmd+1..9 on macOS', () => {
    expect(digit('1')).toEqual({ id: 'target', index: 0 })
    expect(digit('2')).toEqual({ id: 'target', index: 1 })
    expect(digit('9')).toEqual({ id: 'target', index: 8 })
    expect(digit('0')).toEqual(mac ? { id: 'zoomReset' } : null) // not a target
    expect(digit('!', { shiftKey: true, code: 'Digit1' })).toBeNull()
    expect(shortcutLabel('target', mac)).toBe(mac ? '⌘1…9' : 'Alt+1…9')
  })

  it('leaves Ctrl+1..9 to the terminal on Linux: Ctrl+3…8 are ESC, FS, GS, RS, ^_ and DEL there', () => {
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
      expect(press(d, { code: `Digit${d}` })).toEqual(mac ? { id: 'target', index: Number(d) - 1 } : null)
  })

  it('reads the digit from the physical key on layouts where it types a symbol (AZERTY)', () => {
    expect(digit('&', { code: 'Digit1' })).toEqual({ id: 'target', index: 0 })
    expect(digit('é', { code: 'Digit2' })).toEqual({ id: 'target', index: 1 })
  })

  it('zooms out with Mod+- on AZERTY, where "-" is on the 6 key, instead of going to the 6th target', () => {
    expect(press('-', { code: 'Digit6' })).toEqual({ id: 'zoomOut' })
    expect(press('=', { code: 'Digit6' })).toEqual({ id: 'zoomIn' })
    // With the digit chord's modifier, a zoom character on a digit key is not a digit either.
    expect(digit('-', { code: 'Digit6' })).toEqual(mac ? { id: 'zoomOut' } : null)
  })

  it('falls back to the physical letter key on non-Latin layouts, and follows the layout otherwise', () => {
    expect(shifted('З', { code: 'KeyP' })).toEqual({ id: 'palette' }) // Russian
    expect(shifted('Ε', { code: 'KeyE' })).toEqual({ id: 'panel' }) // Greek
    expect(shifted('ש', { code: 'KeyT' })).toEqual({ id: 'newTab' }) // Hebrew
    expect(press('л', { code: 'KeyK' })).toEqual(mac ? { id: 'palette' } : null)
    expect(press('ф', { code: 'KeyA' })).toBeNull()
    // Dvorak: the key typed counts, not where it sits.
    expect(shifted('P', { code: 'KeyR' })).toEqual({ id: 'palette' })
    expect(shifted('R', { code: 'KeyP' })).toBeNull()
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

  it('toggles help with Mod+Shift+/, whether the layout reports "?" or "/"', () => {
    expect(shifted('?')).toEqual({ id: 'help' })
    expect(shifted('/', { code: 'Digit7' })).toEqual({ id: 'help' })
  })

  it('opens the palette with Mod+Shift+P, toggles the panel and focuses the sidebar filter', () => {
    expect(shifted('P')).toEqual({ id: 'palette' })
    expect(shifted('E')).toEqual({ id: 'panel' })
    expect(shifted('F')).toEqual({ id: 'filterSidebar' })
    expect(press('f')).toBeNull()
  })

  it('opens settings with Mod+, (Ctrl+, on Linux, Cmd+, on macOS)', () => {
    expect(press(',')).toEqual({ id: 'settings' })
    expect(press('?', { code: 'Comma' })).toEqual({ id: 'settings' }) // a layout where that key types something else
    expect(shifted(',')).toBeNull()
    expect(shortcutLabel('settings', mac)).toBe(mac ? '⌘,' : 'Ctrl+,')
  })

  it('opens the usage view with Mod+Shift+U, never plain Mod+U', () => {
    expect(shifted('U')).toEqual({ id: 'usage' })
    expect(shifted('u')).toEqual({ id: 'usage' })
    expect(press('u')).toBeNull()
    expect(shortcutLabel('usage', mac)).toBe(mac ? '⌘⇧U' : 'Ctrl+Shift+U')
  })

  it('opens the editor with Mod+Shift+O, never plain Mod+O', () => {
    expect(shifted('O')).toEqual({ id: 'openEditor' })
    expect(press('o')).toBeNull()
  })

  it('zooms the terminal with Mod+= / Mod++, Mod+- and Mod+0, on any layout and the keypad', () => {
    expect(press('=')).toEqual({ id: 'zoomIn' })
    expect(shifted('+', { code: 'Equal' })).toEqual({ id: 'zoomIn' }) // US: + is Shift+=
    expect(press('+', { code: 'BracketRight' })).toEqual({ id: 'zoomIn' }) // German: + has its own key
    expect(press('+', { code: 'NumpadAdd' })).toEqual({ id: 'zoomIn' })
    expect(press('-')).toEqual({ id: 'zoomOut' })
    expect(press('-', { code: 'NumpadSubtract' })).toEqual({ id: 'zoomOut' })
    expect(press('ß', { code: 'Minus' })).toEqual({ id: 'zoomOut' })
    expect(press('0', { code: 'Numpad0' })).toEqual({ id: 'zoomReset' })
    expect(press('à', { code: 'Digit0' })).toEqual({ id: 'zoomReset' }) // AZERTY
    expect(shifted('_', { code: 'Minus' })).toBeNull()
    expect(shifted(')', { code: 'Digit0' })).toBeNull()
    expect(shortcutLabel('zoomIn', mac)).toBe(mac ? '⌘=' : 'Ctrl+=')
  })

  it('adds Mod+K and Mod+/ only on macOS', () => {
    expect(press('k')).toEqual(mac ? { id: 'palette' } : null)
    expect(press('/')).toEqual(mac ? { id: 'help' } : null)
  })

  it("ignores the other platform's modifier, Alt, both modifiers and keyups", () => {
    for (const [k, shiftKey] of [
      ['1', false],
      ['P', true],
      ['?', true],
    ] as const) {
      expect(matchShortcut(key({ key: k, shiftKey, ...wrongMod }), mac)).toBeNull()
      expect(press(k, { shiftKey, altKey: true })).toBeNull()
      expect(press(k, { shiftKey, ctrlKey: true, metaKey: true })).toBeNull()
      expect(press(k, { shiftKey, type: 'keyup' })).toBeNull()
    }
    expect(matchShortcut(key({ key: 'T', ...wrongMod }), mac)).toBeNull()
  })
})

describe('worksWhileTyping', () => {
  it('lets only the palette, help, usage and panel toggles through in text fields', () => {
    expect(worksWhileTyping('palette')).toBe(true)
    expect(worksWhileTyping('help')).toBe(true)
    expect(worksWhileTyping('panel')).toBe(true)
    expect(worksWhileTyping('usage')).toBe(true)
    for (const id of ['filterSidebar', 'target', 'newTab', 'closeTab', 'prevTab', 'nextTab'] as const)
      expect(worksWhileTyping(id)).toBe(false)
  })
})

describe('actsOnRepeat', () => {
  it('lets only zoom steps and tab cycling act again while their keys are held', () => {
    for (const id of ['zoomIn', 'zoomOut', 'prevTab', 'nextTab'] as const) expect(actsOnRepeat(id)).toBe(true)
    for (const id of ['palette', 'help', 'panel', 'sidebar', 'closeTab', 'newTab', 'newTask', 'zoomReset'] as const)
      expect(actsOnRepeat(id)).toBe(false)
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

describe('isModEnter', () => {
  it('is Ctrl+Enter on Linux and Cmd+Enter on macOS, without Shift or Alt', () => {
    const enter = (over: Partial<Parameters<typeof isModEnter>[0]>): Parameters<typeof isModEnter>[0] =>
      key({ key: 'Enter', shiftKey: false, ...over })
    expect(isModEnter(enter({ ctrlKey: true }), false)).toBe(true)
    expect(isModEnter(enter({ metaKey: true }), true)).toBe(true)
    expect(isModEnter(enter({ metaKey: true }), false)).toBe(false)
    expect(isModEnter(enter({ ctrlKey: true }), true)).toBe(false)
    expect(isModEnter(enter({}), false)).toBe(false)
    expect(isModEnter(enter({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isModEnter(enter({ ctrlKey: true, altKey: true }), false)).toBe(false)
  })
})

describe('rowMoveStep', () => {
  const arrow = (over: Partial<Parameters<typeof rowMoveStep>[0]>): Parameters<typeof rowMoveStep>[0] =>
    key({ key: 'ArrowUp', altKey: true, shiftKey: true, ...over })

  it('is -1 for Alt+Shift+↑ and 1 for Alt+Shift+↓ (Option+Shift on macOS)', () => {
    expect(rowMoveStep(arrow({}))).toBe(-1)
    expect(rowMoveStep(arrow({ key: 'ArrowDown' }))).toBe(1)
  })

  it('is 0 for other keys and modifiers', () => {
    expect(rowMoveStep(arrow({ key: 'ArrowLeft' }))).toBe(0)
    expect(rowMoveStep(arrow({ shiftKey: false }))).toBe(0)
    expect(rowMoveStep(arrow({ altKey: false }))).toBe(0)
    expect(rowMoveStep(arrow({ ctrlKey: true }))).toBe(0)
    expect(rowMoveStep(arrow({ metaKey: true }))).toBe(0)
  })
})

describe('rowExtendStep', () => {
  const arrow = (over: Partial<Parameters<typeof rowExtendStep>[0]>): Parameters<typeof rowExtendStep>[0] =>
    key({ key: 'ArrowUp', shiftKey: true, ...over })

  it('is -1 for Shift+↑ and 1 for Shift+↓', () => {
    expect(rowExtendStep(arrow({}))).toBe(-1)
    expect(rowExtendStep(arrow({ key: 'ArrowDown' }))).toBe(1)
  })

  it('is 0 with Alt (that moves the row), another modifier, no Shift or another key', () => {
    expect(rowExtendStep(arrow({ altKey: true }))).toBe(0)
    expect(rowExtendStep(arrow({ ctrlKey: true }))).toBe(0)
    expect(rowExtendStep(arrow({ metaKey: true }))).toBe(0)
    expect(rowExtendStep(arrow({ shiftKey: false }))).toBe(0)
    expect(rowExtendStep(arrow({ key: 'ArrowLeft' }))).toBe(0)
  })
})

describe('clickSelectMode', () => {
  const click = (over: Partial<Parameters<typeof clickSelectMode>[0]>): Parameters<typeof clickSelectMode>[0] => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  })

  it('toggles with Ctrl on Linux and Cmd on macOS, where Ctrl+click is a right click', () => {
    expect(clickSelectMode(click({ ctrlKey: true }), false)).toBe('toggle')
    expect(clickSelectMode(click({ metaKey: true }), true)).toBe('toggle')
    expect(clickSelectMode(click({ metaKey: true }), false)).toBeNull()
    expect(clickSelectMode(click({ ctrlKey: true }), true)).toBeNull()
  })

  it('selects a range with Shift, and adds one with Mod+Shift', () => {
    expect(clickSelectMode(click({ shiftKey: true }), false)).toBe('range')
    expect(clickSelectMode(click({ shiftKey: true, ctrlKey: true }), false)).toBe('addRange')
    expect(clickSelectMode(click({ shiftKey: true, metaKey: true }), true)).toBe('addRange')
  })

  it('is null for a plain click, or with Alt', () => {
    expect(clickSelectMode(click({}), false)).toBeNull()
    expect(clickSelectMode(click({ altKey: true, ctrlKey: true }), false)).toBeNull()
  })
})
