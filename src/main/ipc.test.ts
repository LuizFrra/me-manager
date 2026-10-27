import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_RESIZE, PTY_WRITE } from '../shared/ipc'
import type { Target } from '../shared/types'
import type { AppService, PtyApi } from './contracts'

// Electron stand-ins: the handlers registerIpc installs, and the save dialog it opens.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  showSaveDialog: vi.fn(),
  getPath: vi.fn((name: string) => `/home/me/${name === 'downloads' ? 'Downloads' : name}`),
}))
vi.mock('electron', () => ({
  app: { getPath: electron.getPath },
  BrowserWindow: class {},
  dialog: { showSaveDialog: electron.showSaveDialog, showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => electron.listeners.set(channel, fn),
  },
  shell: { openExternal: vi.fn() },
}))

const { registerIpc } = await import('./ipc')

describe('registerIpc: saveTranscript', () => {
  const target: Target = { themeId: 'th', itemId: 'it' }
  const win = { id: 'the window' }
  let dir: string
  let app: AppService
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-ipc-'))
    electron.handlers.clear()
    electron.showSaveDialog.mockReset()
    app = {
      captureTranscript: vi.fn(async () => ({
        transcript: { text: 'hello\n', lines: 1, truncated: false },
        fileName: 'client-x-notes-claude-20261018-0905.txt',
      })),
    } as unknown as AppService
    const pty = { onData: () => () => {}, onExit: () => () => {} } as unknown as PtyApi
    registerIpc({ app, pty, getWindow: () => win as never })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const save = (index: number): Promise<unknown> =>
    Promise.resolve(electron.handlers.get('api:saveTranscript')!({}, target, index))

  it('opens the save dialog on the window, in Downloads, and writes the chosen file', async () => {
    const path = join(dir, 'out.txt')
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    await expect(save(2)).resolves.toEqual({ path, lines: 1, truncated: false })
    expect(app.captureTranscript).toHaveBeenCalledWith(target, 2)
    expect(electron.showSaveDialog).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ defaultPath: '/home/me/Downloads/client-x-notes-claude-20261018-0905.txt' }),
    )
    await expect(readFile(path, 'utf8')).resolves.toBe('hello\n')
  })

  it('returns null when the dialog is cancelled', async () => {
    electron.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })
    await expect(save(0)).resolves.toBeNull()
  })

  it('leaves copyTranscript to the orchestrator and never exposes captureTranscript', async () => {
    expect(electron.handlers.has('api:copyTranscript')).toBe(true)
    expect(electron.handlers.has('api:captureTranscript')).toBe(false)
  })
})

describe('registerIpc: terminal', () => {
  const pty = { write: vi.fn(), resize: vi.fn(), onData: () => () => {}, onExit: () => () => {} }
  beforeEach(() => {
    pty.write.mockReset()
    pty.resize.mockReset()
    registerIpc({ app: {} as AppService, pty: pty as unknown as PtyApi, getWindow: () => null })
  })
  const send = (channel: string, ...args: unknown[]): void => electron.listeners.get(channel)!({}, ...args)

  it('passes keystrokes and sizes on to the terminal', () => {
    send(PTY_WRITE, 'ls\r')
    send(PTY_RESIZE, 120, 40)
    expect(pty.write).toHaveBeenCalledWith('ls\r')
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
  })

  it('drops input that is not text and sizes that are not positive whole numbers, which node-pty throws on', () => {
    for (const data of [undefined, 42, { a: 1 }]) send(PTY_WRITE, data)
    for (const [cols, rows] of [
      [Number.NaN, 40],
      [120, 0],
      [-1, 40],
      [120.5, 40],
      ['120', 40],
      [Infinity, 40],
      [120, undefined],
    ]) {
      send(PTY_RESIZE, cols, rows)
    }
    expect(pty.write).not.toHaveBeenCalled()
    expect(pty.resize).not.toHaveBeenCalled()
  })
})
