import { homedir } from 'node:os'
import { join } from 'node:path'

export const TMUX_SOCKET = process.env.ME_MANAGER_TMUX_SOCKET || 'me-manager'

export function appHome(): string {
  return process.env.ME_MANAGER_HOME || join(homedir(), '.me-manager')
}

export const stateFile = (): string => join(appHome(), 'state.json')
export const settingsFile = (): string => join(appHome(), 'settings.json')
export const uiStateFile = (): string => join(appHome(), 'ui-state.json')
export const tmuxConfFile = (): string => join(appHome(), 'tmux.conf')
export const worktreesRoot = (): string => join(appHome(), 'worktrees')

export function taskWorktreePath(
  themeSlug: string,
  repoSlug: string,
  taskSlug: string,
  root = worktreesRoot(),
): string {
  return join(root, themeSlug, repoSlug, taskSlug)
}
