import { homedir } from 'node:os'
import { join } from 'node:path'

export const TMUX_SOCKET = process.env.ME_MANAGER_TMUX_SOCKET || 'me-manager'

export function appHome(): string {
  return process.env.ME_MANAGER_HOME || join(homedir(), '.me-manager')
}

export const stateFile = (): string => join(appHome(), 'state.json')
export const settingsFile = (): string => join(appHome(), 'settings.json')
export const uiStateFile = (): string => join(appHome(), 'ui-state.json')
/**
 * What was read from each of Claude Code's transcripts, so that a restart doesn't parse them all again: one file per
 * Claude profile folder, named by a hash of the folder (see ProfileUsage), the Default folder's without one.
 */
export const usageCacheFile = (folderHash?: string, home = appHome()): string =>
  join(home, folderHash ? `usage-cache-${folderHash}.json` : 'usage-cache.json')
/** The budget notifications already sent (see BudgetAlertStore). */
export const budgetAlertsFile = (): string => join(appHome(), 'budget-alerts.json')
export const tmuxConfFile = (): string => join(appHome(), 'tmux.conf')
export const worktreesRoot = (): string => join(appHome(), 'worktrees')
/** Private files holding prompts for `claude` while its tmux window starts (see PromptFiles). */
export const promptsDir = (): string => join(appHome(), 'prompts')

export function taskWorktreePath(
  themeSlug: string,
  repoSlug: string,
  taskSlug: string,
  root = worktreesRoot(),
): string {
  return join(root, themeSlug, repoSlug, taskSlug)
}

/** `~/…` as a path in `home` (the user's home folder by default); any other path as it is. */
export const expandHome = (dir: string, home = homedir()): string => (dir.startsWith('~/') ? home + dir.slice(1) : dir)
