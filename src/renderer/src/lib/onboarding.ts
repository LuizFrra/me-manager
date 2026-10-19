import { isArchived, type AppState, type Target, type Task, type Theme } from '../../../shared/types'
import { shortcutLabel } from './shortcuts'

export interface RecentTask {
  target: Target
  task: Task
  theme: Theme
  repoName: string
}

/** The most recently created active tasks across every theme, newest first: what the home screen offers to reopen. */
export function recentTasks(state: AppState, limit = 5): RecentTask[] {
  const all: RecentTask[] = []
  for (const theme of state.themes)
    for (const item of theme.items) {
      if (item.kind !== 'repo') continue
      for (const task of item.tasks)
        if (!isArchived(task))
          all.push({
            target: { themeId: theme.id, itemId: item.id, taskId: task.id },
            task,
            theme,
            repoName: item.name,
          })
    }
  const time = (t: Task): number => Date.parse(t.createdAt) || 0
  return all.sort((a, b) => time(b.task) - time(a.task)).slice(0, limit)
}

/** One-line tips for the home screen, with this platform's key labels (Ctrl+Shift+…, Alt+… or ⌘⇧…). */
export function homeTips(mac?: boolean): string[] {
  const key = (id: Parameters<typeof shortcutLabel>[0]): string => shortcutLabel(id, mac)
  return [
    `Press ${key('palette')} to jump to any task, folder, file or action.`,
    `${key('panel')} opens the files panel next to the terminal, with the task's changes.`,
    `${key('searchFiles')} searches inside the files of the selected task or folder.`,
    `${key('filterSidebar')} filters the sidebar; ${key('target')} opens the 1st to 9th task in it.`,
    `${key('usage')} shows what Claude has used, per task and theme, with its estimated cost.`,
    `${key('newTab')} opens a shell tab next to Claude, in the task's worktree.`,
    `${key('help')} lists every keyboard shortcut.`,
  ]
}

/** How often the home screen's tip changes. */
export const TIP_ROTATE_MS = 8_000
