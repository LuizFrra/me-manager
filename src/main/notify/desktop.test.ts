import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SELECT_TARGET } from '../../shared/ipc'

const electron = vi.hoisted(() => {
  type Handler = () => void
  class FakeNotification {
    static supported = true
    static instances: FakeNotification[] = []
    static isSupported(): boolean {
      return FakeNotification.supported
    }
    handlers = new Map<string, Handler>()
    shown = false
    constructor(readonly options: { title: string; body: string; icon?: string }) {
      FakeNotification.instances.push(this)
    }
    on(event: string, handler: Handler): this {
      this.handlers.set(event, handler)
      return this
    }
    show(): void {
      this.shown = true
    }
    emit(event: string): void {
      this.handlers.get(event)?.()
    }
  }
  return { FakeNotification }
})
vi.mock('electron', () => ({ Notification: electron.FakeNotification }))

const { createDesktopNotifier } = await import('./desktop')
const { FakeNotification } = electron

interface FakeWindow {
  loaded: (() => void)[]
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
  webContents: {
    send: (...args: unknown[]) => void
    isLoading: () => boolean
    once: (e: string, cb: () => void) => void
  }
}

function fakeWindow(opts: { minimized?: boolean; loading?: boolean } = {}): FakeWindow {
  const loaded: (() => void)[] = []
  return {
    loaded,
    isMinimized: vi.fn(() => opts.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => opts.loading ?? false),
      once: vi.fn((_event: string, cb: () => void) => loaded.push(cb)),
    },
  }
}

const notice = {
  title: 'Claude finished',
  body: 'Client X › my-api › Fix login',
  target: { themeId: 't', itemId: 'r', taskId: 'k' },
}

describe('createDesktopNotifier', () => {
  beforeEach(() => {
    FakeNotification.instances = []
    FakeNotification.supported = true
  })

  it('shows a native notification with the title, body and icon', () => {
    const notify = createDesktopNotifier({ getWindow: () => fakeWindow() as never, icon: '/icon.png' })
    notify(notice)
    const [n] = FakeNotification.instances
    expect(n.options).toEqual({ title: 'Claude finished', body: 'Client X › my-api › Fix login', icon: '/icon.png' })
    expect(n.shown).toBe(true)
  })

  it('focuses the window and selects the target on click', () => {
    const win = fakeWindow({ minimized: true })
    createDesktopNotifier({ getWindow: () => win as never })(notice)
    FakeNotification.instances[0].emit('click')
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith(SELECT_TARGET, notice.target)
  })

  it('waits for a window that is still loading (re-created after being closed)', () => {
    const win = fakeWindow({ loading: true })
    createDesktopNotifier({ getWindow: () => win as never })(notice)
    FakeNotification.instances[0].emit('click')
    expect(win.webContents.send).not.toHaveBeenCalled()
    win.loaded.forEach((cb) => cb())
    expect(win.webContents.send).toHaveBeenCalledWith(SELECT_TARGET, notice.target)
  })

  it('does nothing where notifications are not supported', () => {
    FakeNotification.supported = false
    createDesktopNotifier({ getWindow: () => fakeWindow() as never })(notice)
    expect(FakeNotification.instances).toEqual([])
  })
})
