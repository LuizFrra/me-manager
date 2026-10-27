import { describe, expect, it } from 'vitest'
import { terminalKeyAction } from './terminalKeys'

const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init }) as KeyboardEvent

describe('terminalKeyAction', () => {
  it('copies and pastes with Ctrl+C / Ctrl+V and their Shift and Insert forms on Linux', () => {
    expect(terminalKeyAction(key({ key: 'c', code: 'KeyC', ctrlKey: true }), false)).toBe('copyOrInterrupt')
    expect(terminalKeyAction(key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), false)).toBe('copy')
    expect(terminalKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true }), false)).toBe('pasteOrImage')
    expect(terminalKeyAction(key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }), false)).toBe('paste')
    expect(terminalKeyAction(key({ key: 'Insert', ctrlKey: true }), false)).toBe('copy')
    expect(terminalKeyAction(key({ key: 'Insert', shiftKey: true }), false)).toBe('paste')
  })

  it('finds C and V by the physical key on a non-Latin layout, and by the letter on Dvorak', () => {
    expect(terminalKeyAction(key({ key: 'с', code: 'KeyC', ctrlKey: true }), false)).toBe('copyOrInterrupt')
    expect(terminalKeyAction(key({ key: 'м', code: 'KeyV', ctrlKey: true }), false)).toBe('pasteOrImage')
    // Dvorak: the key in QWERTY's C position types J
    expect(terminalKeyAction(key({ key: 'j', code: 'KeyC', ctrlKey: true }), false)).toBeNull()
  })

  it('leaves other keys, Alt and Meta combinations, and macOS clipboard keys to the terminal', () => {
    expect(terminalKeyAction(key({ key: 'd', code: 'KeyD', ctrlKey: true }), false)).toBeNull()
    expect(terminalKeyAction(key({ key: 'c', code: 'KeyC' }), false)).toBeNull()
    expect(terminalKeyAction(key({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(terminalKeyAction(key({ key: 'c', code: 'KeyC', ctrlKey: true }), true)).toBeNull()
    expect(terminalKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true }), true)).toBeNull()
    expect(terminalKeyAction(key({ key: 'Enter' }), false)).toBeNull()
  })

  it('makes Shift+Enter a newline on both platforms', () => {
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true }), false)).toBe('newline')
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true }), true)).toBe('newline')
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true, ctrlKey: true }), false)).toBeNull()
  })
})
