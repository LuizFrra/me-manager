import { app as electronApp, BrowserWindow, dialog, ipcMain, shell, type SaveDialogOptions } from 'electron'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  INVOKE_METHODS,
  invokeChannel,
  PTY_DATA,
  PTY_EXIT,
  PTY_RESIZE,
  PTY_WRITE,
  type InvokeMethod,
} from '../shared/ipc'
import type { Target } from '../shared/types'
import type { AppService, PtyApi } from './contracts'
import { TMUX_SOCKET } from './paths'
import { checkPrereqs } from './prereqs'
import { saveTranscript, type TranscriptSaveDeps } from './transcript'
import { isHttpUrl } from './urls'

type Handler = (...args: unknown[]) => unknown

/** A terminal's columns or rows as the renderer sends them: a positive whole number a pty can take. */
const isTermSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 0xffff

/** Electron's save dialog for a transcript, on the window when there is one; asks before replacing a file. */
async function askTranscriptPath(win: BrowserWindow | null, defaultPath: string): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: 'Save transcript',
    defaultPath,
    filters: [
      { name: 'Text files', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** The Downloads folder, or the home folder when the platform has none. */
function downloadsDir(): string {
  try {
    return electronApp.getPath('downloads')
  } catch {
    return homedir()
  }
}

export function registerIpc(opts: { app: AppService; pty: PtyApi; getWindow: () => BrowserWindow | null }): void {
  const { app, pty, getWindow } = opts
  const transcripts: TranscriptSaveDeps = {
    capture: (target, index) => app.captureTranscript(target, index),
    askSavePath: (defaultPath) => askTranscriptPath(getWindow(), defaultPath),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    downloadsDir,
  }

  const special: Partial<Record<InvokeMethod, Handler>> = {
    checkPrereqs: () => checkPrereqs(),
    getTmuxSocket: () => TMUX_SOCKET,
    pickDirectory: async () => {
      const win = getWindow()
      const options = { properties: ['openDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    saveTranscript: (target, index) => saveTranscript(transcripts, target as Target, index as number),
    openExternal: async (url) => {
      if (!isHttpUrl(String(url))) throw new Error('Only http(s) links can be opened')
      await shell.openExternal(new URL(String(url)).toString())
    },
  }

  for (const method of INVOKE_METHODS) {
    const handler: Handler =
      special[method] ?? ((...args) => (app[method as keyof AppService] as unknown as Handler).apply(app, args))
    ipcMain.handle(invokeChannel(method), (_event, ...args: unknown[]) => handler(...args))
  }

  // Checked first: node-pty throws on a size that isn't a positive number, and a throw in a listener here is an
  // uncaught exception in the main process.
  ipcMain.on(PTY_WRITE, (_event, data: unknown) => {
    if (typeof data === 'string') pty.write(data)
  })
  ipcMain.on(PTY_RESIZE, (_event, cols: unknown, rows: unknown) => {
    if (isTermSize(cols) && isTermSize(rows)) pty.resize(cols, rows)
  })
  pty.onData((data) => getWindow()?.webContents.send(PTY_DATA, data))
  pty.onExit((code) => getWindow()?.webContents.send(PTY_EXIT, code))
}
