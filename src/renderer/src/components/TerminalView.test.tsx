import { render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TerminalView } from './TerminalView'

type KeyHandler = (e: KeyboardEvent) => boolean
const handlers: KeyHandler[] = []
const noop = (): void => undefined
interface FakeTerm {
  options: { fontSize?: number }
  cols: number
  rows: number
}
const terms = vi.hoisted(() => [] as FakeTerm[])
const fits = vi.hoisted(() => ({ count: 0 }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: { fontSize?: number }
    constructor(options: { fontSize?: number }) {
      this.options = { ...options }
      terms.push(this)
    }
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
    fit(): void {
      fits.count++
    }
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
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    const handler = handlers.at(-1)
    expect(handler).toBeDefined()
    const shortcuts = [
      key({ key: 'P', shiftKey: true }),
      key({ key: '?', shiftKey: true }),
      key({ key: ',' }),
      key({ key: 'O', shiftKey: true }),
      key({ key: 'U', shiftKey: true }),
      key({ key: 'S', shiftKey: true }),
      key({ key: '=' }),
      key({ key: '+', shiftKey: true, code: 'Equal' }),
      key({ key: '-' }),
      key({ key: '0' }),
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
      key({ key: 'u' }), // readline: kill to the start of the line
      key({ key: 's' }), // flow control / readline forward search
      key({ key: 'a', ctrlKey: false }),
    ]
    for (const e of terminalKeys) expect(handler?.(e), `${e.key} should reach tmux`).toBe(true)
  })
  it('swallows every key while a modal is open, and lets them through again after', () => {
    const { rerender } = render(<TerminalView api={api} sessionKey="s" fontSize={13} modalOpen />)
    const handler = handlers.at(-1)
    const plain = new KeyboardEvent('keydown', { key: 'a' })
    const escape = new KeyboardEvent('keydown', { key: 'Escape' })
    expect(handler?.(plain)).toBe(false)
    expect(handler?.(escape)).toBe(false)
    rerender(<TerminalView api={api} sessionKey="s" fontSize={13} modalOpen={false} />)
    expect(handlers.at(-1)).toBe(handler) // the same terminal
    expect(handler?.(plain)).toBe(true)
    expect(handler?.(escape)).toBe(true)
  })
})

describe('TerminalView font size', () => {
  it('starts with the given size and applies changes live, refitting and resizing the pty', () => {
    const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }
    const { rerender } = render(<TerminalView api={api} sessionKey="s" fontSize={15} />)
    const term = terms.at(-1)!
    expect(term.options.fontSize).toBe(15)
    const created = terms.length
    api.ptyResize.mockClear()
    const fitsBefore = fits.count

    term.cols = 70
    term.rows = 20
    rerender(<TerminalView api={api} sessionKey="s" fontSize={17} />)
    expect(terms.length).toBe(created) // the same terminal, not a new one
    expect(term.options.fontSize).toBe(17)
    expect(fits.count).toBe(fitsBefore + 1)
    expect(api.ptyResize).toHaveBeenCalledWith(70, 20)

    api.ptyResize.mockClear()
    rerender(<TerminalView api={api} sessionKey="s" fontSize={17} />)
    expect(api.ptyResize).not.toHaveBeenCalled()
  })
})
