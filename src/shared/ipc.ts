import type { MeManagerApi } from './types'

/** Methods of MeManagerApi that go over ipcRenderer.invoke. */
export const INVOKE_METHODS = [
  'getState',
  'getStatus',
  'getGitStatus',
  'checkPrereqs',
  'getTmuxSocket',
  'getUiState',
  'saveUiState',
  'getSettings',
  'updateSettings',
  'createTheme',
  'renameTheme',
  'customizeTheme',
  'removeTheme',
  'restoreTheme',
  'moveTheme',
  'pickDirectory',
  'addRepo',
  'cloneRepo',
  'addFolder',
  'setRunCommand',
  'removeItem',
  'restoreItem',
  'moveItem',
  'listBranches',
  'createTask',
  'renameTask',
  'setTaskNotes',
  'setTaskBudget',
  'checkTaskRemoval',
  'removeTask',
  'archiveTask',
  'unarchiveTask',
  'moveTask',
  'openTarget',
  'detachTerminal',
  'listTabs',
  'newTab',
  'selectTab',
  'closeTab',
  'restartClaude',
  'startRun',
  'restartRun',
  'stopRun',
  'getDevUrls',
  'copyTranscript',
  'saveTranscript',
  'listFiles',
  'readFile',
  'readImage',
  'searchFiles',
  'listChanges',
  'fileDiff',
  'openInEditor',
  'openInFileManager',
  'openExternal',
  'getGitTools',
  'commitAll',
  'pushTask',
  'createPullRequest',
  'updateFromBase',
  'askClaudeToResolve',
  'sendToClaude',
  'getUsage',
  'getUsageReport',
] as const satisfies readonly (keyof MeManagerApi)[]

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

export const invokeChannel = (method: InvokeMethod): string => `api:${method}`

export const PTY_WRITE = 'pty:write'
export const PTY_RESIZE = 'pty:resize'
export const PTY_DATA = 'pty:data'
export const PTY_EXIT = 'pty:exit'
/** Main → renderer: select this target (a desktop notification was clicked). */
export const SELECT_TARGET = 'app:select-target'
