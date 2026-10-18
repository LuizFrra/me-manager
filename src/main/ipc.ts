import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  INVOKE_METHODS,
  invokeChannel,
  PTY_DATA,
  PTY_EXIT,
  PTY_RESIZE,
  PTY_WRITE,
  type InvokeMethod,
} from '../shared/ipc'
import type { AppService, PtyApi } from './contracts'
import { TMUX_SOCKET } from './paths'
import { checkPrereqs } from './prereqs'
import { isHttpUrl } from './urls'

type Handler = (...args: unknown[]) => unknown

export function registerIpc(opts: { app: AppService; pty: PtyApi; getWindow: () => BrowserWindow | null }): void {
  const { app, pty, getWindow } = opts

  const special: Partial<Record<InvokeMethod, Handler>> = {
    checkPrereqs: () => checkPrereqs(),
    getTmuxSocket: () => TMUX_SOCKET,
    pickDirectory: async () => {
      const win = getWindow()
      const options = { properties: ['openDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
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

  ipcMain.on(PTY_WRITE, (_event, data: string) => pty.write(data))
  ipcMain.on(PTY_RESIZE, (_event, cols: number, rows: number) => pty.resize(cols, rows))
  pty.onData((data) => getWindow()?.webContents.send(PTY_DATA, data))
  pty.onExit((code) => getWindow()?.webContents.send(PTY_EXIT, code))
}
