import type { IClipboardProvider } from '@xterm/addon-clipboard'
import { render } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_THEMES } from '../lib/terminalTheme'
import { TerminalView } from './TerminalView'

type KeyHandler = (e: KeyboardEvent) => boolean
const handlers: KeyHandler[] = []
const noop = (): void => undefined
interface FakeTerm {
  options: { fontSize?: number; theme?: unknown; minimumContrastRatio?: number }
  cols: number
  rows: number
}
const terms = vi.hoisted(() => [] as FakeTerm[])
const fits = vi.hoisted(() => ({ count: 0 }))
const providers = vi.hoisted(() => [] as IClipboardProvider[])
const xtermSelection = vi.hoisted(() => ({ text: '' }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: FakeTerm['options']
    constructor(options: FakeTerm['options']) {
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
      return xtermSelection.text !== ''
    }
    getSelection(): string {
      return xtermSelection.text
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
vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {
    constructor(_base64: unknown, provider: IClipboardProvider) {
      providers.push(provider)
    }
  },
}))

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
      key({ key: '1', ctrlKey: false, altKey: true }),
      key({ key: '9', ctrlKey: false, altKey: true }),
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
      // Ctrl+3…8 are control codes in a terminal (ESC, FS/SIGQUIT, GS, RS, ^_ undo, DEL)
      ...['1', '3', '4', '5', '6', '7', '8', '9'].map((d) => key({ key: d, code: `Digit${d}` })),
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

describe('TerminalView clipboard', () => {
  const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
  beforeEach(() => {
    writeText.mockClear()
    xtermSelection.text = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => '' },
    })
  })
  // tmux sends a mouse selection (a drag, or a double-click on a word) as OSC 52 with an empty selection.
  const tmuxSelects = (text: string): unknown => providers.at(-1)?.writeText('' as never, text)
  const copyKeys = (): boolean | undefined =>
    handlers.at(-1)?.(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true }))
  // The macOS Edit menu's Copy (Cmd+C) fires a copy event at the focused terminal.
  const menuCopy = (target: Element): { setData: ReturnType<typeof vi.fn>; event: Event } => {
    const setData = vi.fn()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData } })
    target.dispatchEvent(event)
    return { setData, event }
  }

  it('leaves the clipboard alone when text is selected with the mouse in tmux', async () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    await tmuxSelects('e')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies the last mouse selection with Ctrl+Shift+C when xterm has no selection of its own', async () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    await tmuxSelects('world')
    expect(copyKeys()).toBe(false)
    expect(writeText).toHaveBeenCalledWith('world')
    xtermSelection.text = 'forced'
    copyKeys()
    expect(writeText).toHaveBeenLastCalledWith('forced')
  })

  it('copies nothing with Ctrl+Shift+C when nothing was selected', () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    copyKeys()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('gives the menu Copy the last mouse selection, and leaves an xterm selection to xterm', async () => {
    const { container } = render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    const host = container.querySelector('.terminal-host') as Element
    expect(menuCopy(host).setData).not.toHaveBeenCalled()
    await tmuxSelects('world')
    const copied = menuCopy(host)
    expect(copied.setData).toHaveBeenCalledWith('text/plain', 'world')
    expect(copied.event.defaultPrevented).toBe(true)
    xtermSelection.text = 'forced'
    expect(menuCopy(host).setData).not.toHaveBeenCalled()
  })

  it('forgets the mouse selection when another session is shown', async () => {
    const { rerender } = render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    await tmuxSelects('world')
    rerender(<TerminalView api={api} sessionKey="other" fontSize={13} />)
    copyKeys()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('writes the clipboard right away when a program asks for it', async () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    await providers.at(-1)?.writeText('c' as never, 'from claude')
    expect(writeText).toHaveBeenCalledWith('from claude')
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

describe('TerminalView appearance', () => {
  it('starts in the given appearance and switches palettes live, on the same terminal', () => {
    const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }
    const { rerender } = render(<TerminalView api={api} sessionKey="s" fontSize={13} appearance="light" />)
    const term = terms.at(-1)!
    const created = terms.length
    expect(term.options.theme).toEqual(TERMINAL_THEMES.light)
    expect(term.options.minimumContrastRatio).toBe(4.5)

    rerender(<TerminalView api={api} sessionKey="s" fontSize={13} appearance="dark" />)
    expect(terms.length).toBe(created)
    expect(term.options.theme).toEqual(TERMINAL_THEMES.dark)
    expect(term.options.minimumContrastRatio).toBe(1)

    rerender(<TerminalView api={api} sessionKey="s" fontSize={13} appearance="light" />)
    expect(terms.length).toBe(created)
    expect(term.options.theme).toEqual(TERMINAL_THEMES.light)
  })

  it('is dark by default', () => {
    render(
      <TerminalView
        api={{ ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }}
        sessionKey="s"
        fontSize={13}
      />,
    )
    expect(terms.at(-1)!.options.theme).toEqual(TERMINAL_THEMES.dark)
  })
})
