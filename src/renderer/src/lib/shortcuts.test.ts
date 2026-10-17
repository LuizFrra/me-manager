import { describe, expect, it } from 'vitest'
import { isPanelShortcut } from './shortcuts'

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
