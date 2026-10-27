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

const TIP_KEY = 'me-manager.homeTip'
/** The tip shown last in this run: what Home goes on from where storage is unavailable. */
let sessionTip = -1

/** The index of the tip Home showed last, kept across restarts; -1 before any. */
export function loadLastTip(): number {
  try {
    const raw = localStorage.getItem(TIP_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : -1
  } catch {
    return sessionTip
  }
}

export function saveLastTip(index: number): void {
  sessionTip = index
  try {
    localStorage.setItem(TIP_KEY, String(index))
  } catch {
    // storage may be unavailable; the tip is remembered for this run only
  }
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

/** How long ago `iso` was, coarsely: "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or the date. */
export function timeAgo(iso: string, now: Date): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor((now.getTime() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(then).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}
