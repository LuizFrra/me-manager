import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE_METHODS, invokeChannel, PTY_DATA, PTY_EXIT, PTY_RESIZE, PTY_WRITE } from '../shared/ipc'
import type { MeManagerApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invokers = Object.fromEntries(
  INVOKE_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(invokeChannel(method), ...args)]),
)

const api = {
  ...invokers,
  ptyWrite: (data: string) => ipcRenderer.send(PTY_WRITE, data),
  ptyResize: (cols: number, rows: number) => ipcRenderer.send(PTY_RESIZE, cols, rows),
  onPtyData: (cb: (data: string) => void) => subscribe(PTY_DATA, cb),
  onPtyExit: (cb: (code: number) => void) => subscribe(PTY_EXIT, cb),
} as unknown as MeManagerApi

contextBridge.exposeInMainWorld('api', api)
