import { BrowserWindow, dialog, ipcMain } from 'electron'
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
import { checkPrereqs } from './prereqs'

type Handler = (...args: unknown[]) => unknown

export function registerIpc(opts: { app: AppService; pty: PtyApi; getWindow: () => BrowserWindow | null }): void {
  const { app, pty, getWindow } = opts

  const special: Partial<Record<InvokeMethod, Handler>> = {
    checkPrereqs: () => checkPrereqs(),
    pickDirectory: async () => {
      const win = getWindow()
      const options = { properties: ['openDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
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
