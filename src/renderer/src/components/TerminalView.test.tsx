import type { IClipboardProvider } from '@xterm/addon-clipboard'
import type { ILinkHandler, ILinkProvider } from '@xterm/xterm'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_THEMES } from '../lib/terminalTheme'
import { TerminalView } from './TerminalView'

type KeyHandler = (e: KeyboardEvent) => boolean
const handlers: KeyHandler[] = []
const noop = (): void => undefined
interface FakeTerm {
  options: { fontSize?: number; theme?: unknown; minimumContrastRatio?: number; linkHandler?: ILinkHandler }
  cols: number
  rows: number
  pasted: string[]
  linkProviders: ILinkProvider[]
  input?: (data: string) => void
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
    pasted: string[] = []
    linkProviders: ILinkProvider[] = []
    input?: (data: string) => void
    textarea = undefined
    loadAddon = noop
    open = noop
    attachCustomKeyEventHandler(handler: KeyHandler): void {
      handlers.push(handler)
    }
    registerLinkProvider(provider: ILinkProvider): { dispose: () => void } {
      this.linkProviders.push(provider)
      return { dispose: noop }
    }
    onData(cb: (data: string) => void): { dispose: () => void } {
      this.input = cb
      return { dispose: () => {} }
    }
    paste(text: string): void {
      this.pasted.push(text)
    }
    clearSelection(): void {
      xtermSelection.text = ''
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

describe('TerminalView Ctrl+C, Ctrl+V and Shift+Enter (Linux)', () => {
  const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
  const clip = { text: '' }
  beforeEach(() => {
    writeText.mockClear()
    api.ptyWrite.mockClear()
    xtermSelection.text = ''
    clip.text = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => clip.text },
    })
  })
  const press = (init: KeyboardEventInit): boolean | undefined =>
    handlers.at(-1)?.(new KeyboardEvent('keydown', { cancelable: true, ...init }))
  const ctrlC = (): boolean | undefined => press({ key: 'c', code: 'KeyC', ctrlKey: true })
  const tmuxSelects = (text: string): Promise<void> =>
    act(async () => {
      await providers.at(-1)?.writeText('' as never, text)
    })

  it('copies a selection with Ctrl+C, and interrupts (sends ^C) when nothing is selected', async () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    expect(ctrlC()).toBe(true) // nothing selected: xterm sends ^C
    xtermSelection.text = 'picked'
    expect(ctrlC()).toBe(false)
    expect(writeText).toHaveBeenCalledWith('picked')
    expect(xtermSelection.text).toBe('') // cleared, so the next Ctrl+C interrupts
    expect(ctrlC()).toBe(true)
    expect(await screen.findByRole('status')).toHaveTextContent('Copied')
  })

  it('copies a fresh tmux mouse selection with Ctrl+C once, and shows that it can', async () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    await tmuxSelects('from tmux')
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl+C to copy')
    expect(ctrlC()).toBe(false)
    expect(writeText).toHaveBeenCalledWith('from tmux')
    expect(ctrlC()).toBe(true)
  })

  it('lets Ctrl+C interrupt once the user typed after selecting, or clicked again', async () => {
    const { container } = render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    await tmuxSelects('old')
    act(() => terms.at(-1)?.input?.('x'))
    expect(ctrlC()).toBe(true)
    await tmuxSelects('again')
    act(() => terms.at(-1)?.input?.('\x1b[<0;3;4M')) // a mouse report is not typing
    expect(ctrlC()).toBe(false)
    await tmuxSelects('third')
    fireEvent.mouseDown(container.querySelector('.terminal-host') as Element, { button: 0 })
    expect(ctrlC()).toBe(true)
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('pastes text with Ctrl+V, and sends ^V for Claude to paste an image when there is no text', async () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    clip.text = 'hello'
    expect(press({ key: 'v', code: 'KeyV', ctrlKey: true })).toBe(false)
    await vi.waitFor(() => expect(terms.at(-1)?.pasted).toEqual(['hello']))
    clip.text = ''
    press({ key: 'v', code: 'KeyV', ctrlKey: true })
    await vi.waitFor(() => expect(api.ptyWrite).toHaveBeenCalledWith('\x16'))
    expect(terms.at(-1)?.pasted).toEqual(['hello'])
  })

  it('stops the native paste from pasting a second time', () => {
    render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    const e = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, cancelable: true })
    handlers.at(-1)?.(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it("starts a new line with Shift+Enter in Claude's tab only", () => {
    const { rerender } = render(<TerminalView api={api} sessionKey="s" fontSize={13} claudeTab />)
    expect(press({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(api.ptyWrite).toHaveBeenCalledWith('\x1b\r')
    api.ptyWrite.mockClear()
    rerender(<TerminalView api={api} sessionKey="s" fontSize={13} claudeTab={false} />)
    expect(press({ key: 'Enter', shiftKey: true })).toBe(true) // a shell gets a plain Enter
    expect(api.ptyWrite).not.toHaveBeenCalled()
  })
})

describe('TerminalView links', () => {
  const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }

  it('follows OSC 8 hyperlinks on Ctrl+click only, and only http(s) ones', () => {
    const onOpenUrl = vi.fn()
    render(<TerminalView api={api} sessionKey="s" fontSize={13} onOpenUrl={onOpenUrl} />)
    const handler = terms.at(-1)?.options.linkHandler
    const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }
    handler?.activate(new MouseEvent('mouseup'), 'https://a.dev', range)
    expect(onOpenUrl).not.toHaveBeenCalled()
    handler?.activate(new MouseEvent('mouseup', { ctrlKey: true }), 'file:///etc/passwd', range)
    expect(onOpenUrl).not.toHaveBeenCalled()
    handler?.activate(new MouseEvent('mouseup', { ctrlKey: true }), 'https://a.dev', range)
    expect(onOpenUrl).toHaveBeenCalledWith('https://a.dev')
  })

  it('registers a link provider whose links open URLs and files of the task', async () => {
    const onOpenUrl = vi.fn()
    const onOpenFile = vi.fn()
    render(
      <TerminalView
        api={api}
        sessionKey="s"
        fontSize={13}
        onOpenUrl={onOpenUrl}
        onOpenFile={onOpenFile}
        loadLinkFiles={async () => ({ root: '/r', files: new Set(['src/a.ts']) })}
      />,
    )
    const term = terms.at(-1) as FakeTerm & { buffer?: unknown }
    const row = 'see https://a.dev and src/a.ts:9'
    term.buffer = {
      active: {
        getLine: (y: number) =>
          y === 0
            ? {
                isWrapped: false,
                length: row.length,
                getCell: (x: number) => ({ getChars: () => row[x], getWidth: () => 1 }),
              }
            : undefined,
      },
    }
    const links = await new Promise<{ text: string; activate: (e: MouseEvent, t: string) => void }[]>((resolve) =>
      term.linkProviders[0].provideLinks(1, (l) => resolve((l ?? []) as never)),
    )
    expect(links.map((l) => l.text)).toEqual(['https://a.dev', 'src/a.ts:9'])
    links[0].activate(new MouseEvent('mouseup'), links[0].text)
    expect(onOpenUrl).not.toHaveBeenCalled() // a plain click focuses or selects
    links[0].activate(new MouseEvent('mouseup', { ctrlKey: true }), links[0].text)
    links[1].activate(new MouseEvent('mouseup', { ctrlKey: true }), links[1].text)
    expect(onOpenUrl).toHaveBeenCalledWith('https://a.dev')
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts', 9)
  })
})

describe('TerminalView context menu', () => {
  const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }
  beforeEach(() => {
    xtermSelection.text = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}), readText: async () => 'clip' },
    })
  })

  it('opens on a right click with Paste, and Copy when something is selected', async () => {
    const { container } = render(<TerminalView api={api} sessionKey="s" fontSize={13} />)
    const host = container.querySelector('.terminal-host') as Element
    fireEvent.contextMenu(host, { clientX: 10, clientY: 10 })
    expect(screen.getByRole('menuitem', { name: 'Paste' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paste' }))
    await vi.waitFor(() => expect(terms.at(-1)?.pasted).toEqual(['clip']))
    expect(screen.queryByRole('menu')).toBeNull()

    xtermSelection.text = 'sel'
    fireEvent.contextMenu(host, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sel')
  })
})

describe('TerminalView after a scroll back', () => {
  const api = { ptyWrite: vi.fn(), ptyResize: vi.fn(), onPtyData: () => () => {} }
  beforeEach(() => api.ptyWrite.mockClear())

  it('leaves copy mode before the next typed key, and holds what is typed meanwhile', async () => {
    let leave = (): void => {}
    const onLeaveCopyMode = vi.fn(() => new Promise<void>((resolve) => (leave = resolve)))
    const { container } = render(
      <TerminalView api={api} sessionKey="s" fontSize={13} onLeaveCopyMode={onLeaveCopyMode} />,
    )
    const type = (data: string): void => terms.at(-1)?.input?.(data)
    type('a') // no scroll yet: straight through
    expect(onLeaveCopyMode).not.toHaveBeenCalled()
    fireEvent.wheel(container.querySelector('.terminal-host') as Element, { deltaY: -120 })
    type('\x1b[A') // ↑ still scrolls in copy mode
    expect(api.ptyWrite.mock.calls.map(([d]) => d)).toEqual(['a', '\x1b[A'])
    type('h')
    type('i')
    expect(onLeaveCopyMode).toHaveBeenCalledTimes(1)
    expect(api.ptyWrite).toHaveBeenCalledTimes(2) // held until tmux is out of copy mode
    await act(async () => leave())
    expect(api.ptyWrite.mock.calls.map(([d]) => d)).toEqual(['a', '\x1b[A', 'h', 'i'])
    type('!')
    expect(onLeaveCopyMode).toHaveBeenCalledTimes(1)
    expect(api.ptyWrite).toHaveBeenLastCalledWith('!')
  })

  it('only leaves copy mode on Escape, so it does not also interrupt Claude', async () => {
    const onLeaveCopyMode = vi.fn(async () => {})
    const { container } = render(
      <TerminalView api={api} sessionKey="s" fontSize={13} onLeaveCopyMode={onLeaveCopyMode} />,
    )
    fireEvent.wheel(container.querySelector('.terminal-host') as Element, { deltaY: -120 })
    await act(async () => terms.at(-1)?.input?.('\x1b'))
    expect(onLeaveCopyMode).toHaveBeenCalledTimes(1)
    expect(api.ptyWrite).not.toHaveBeenCalled()
  })
})
