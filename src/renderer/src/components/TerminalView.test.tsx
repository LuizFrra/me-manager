import { render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TerminalView } from './TerminalView'

type KeyHandler = (e: KeyboardEvent) => boolean
const handlers: KeyHandler[] = []
const noop = (): void => undefined

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon = noop
    open = noop
    attachCustomKeyEventHandler(handler: KeyHandler): void {
      handlers.push(handler)
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    write = noop
    reset = noop
    focus = noop
    dispose = noop
    hasSelection(): boolean {
      return false
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = noop
  },
}))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe = noop
    disconnect = noop
    unobserve = noop
  } as unknown as typeof ResizeObserver
})

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { ctrlKey: true, ...init })

describe('TerminalView key handler', () => {
  const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }

  it('keeps every app shortcut away from tmux and passes other keys through', () => {
    render(<TerminalView api={api} sessionKey="s" />)
    const handler = handlers.at(-1)
    expect(handler).toBeDefined()
    const shortcuts = [
      key({ key: 'P', shiftKey: true }),
      key({ key: '?', shiftKey: true }),
      key({ key: ',' }),
      key({ key: 'O', shiftKey: true }),
      key({ key: 'E', shiftKey: true }),
      key({ key: '1' }),
      key({ key: '9' }),
      key({ key: 'T', shiftKey: true }),
      key({ key: 'W', shiftKey: true }),
      key({ key: '{', shiftKey: true, code: 'BracketLeft' }),
      key({ key: '}', shiftKey: true, code: 'BracketRight' }),
    ]
    for (const e of shortcuts) expect(handler?.(e), `${e.key} goes to tmux`).toBe(false)
    const terminalKeys = [
      key({ key: 'k' }), // readline / Claude Code: kill to the end of the line
      key({ key: '/' }), // undo
      key({ key: 'c' }),
      key({ key: 't' }),
      key({ key: 'w' }),
      key({ key: 'p' }),
      key({ key: ',', shiftKey: true }),
      key({ key: 'o' }),
      key({ key: 'a', ctrlKey: false }),
    ]
    for (const e of terminalKeys) expect(handler?.(e), `${e.key} should reach tmux`).toBe(true)
  })
})
