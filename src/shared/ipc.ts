import type { MeManagerApi } from './types'

/** Methods of MeManagerApi that go over ipcRenderer.invoke. */
export const INVOKE_METHODS = [
  'getState',
  'getStatus',
  'checkPrereqs',
  'createTheme',
  'removeTheme',
  'pickDirectory',
  'addRepo',
  'addFolder',
  'removeItem',
  'createTask',
  'checkTaskRemoval',
  'removeTask',
  'openTarget',
  'listTabs',
  'newTab',
  'selectTab',
  'closeTab',
  'restartClaude',
] as const satisfies readonly (keyof MeManagerApi)[]

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

export const invokeChannel = (method: InvokeMethod): string => `api:${method}`

export const PTY_WRITE = 'pty:write'
export const PTY_RESIZE = 'pty:resize'
export const PTY_DATA = 'pty:data'
export const PTY_EXIT = 'pty:exit'
