import type { AppState, Item, Target, Task, Theme } from '../../../shared/types'

export interface ResolvedTarget {
  theme: Theme
  item: Item
  /** Set for a repo task. */
  task?: Task
}

/** The theme, item and task a target points to, or null if it no longer exists. */
export function resolveTarget(state: AppState, target: Target): ResolvedTarget | null {
  const theme = state.themes.find((t) => t.id === target.themeId)
  const item = theme?.items.find((i) => i.id === target.itemId)
  if (!theme || !item) return null
  if (item.kind === 'folder') return { theme, item }
  const task = item.tasks.find((t) => t.id === target.taskId)
  return task ? { theme, item, task } : null
}

/** Header text for the selected target, or null if it no longer exists. */
export function describeTarget(state: AppState, target: Target): { title: string; subtitle: string } | null {
  const found = resolveTarget(state, target)
  if (!found) return null
  const { theme, item, task } = found
  if (item.kind === 'folder') return { title: `${theme.name} › ${item.name}`, subtitle: item.path }
  if (!task) return null
  return { title: `${item.name} › ${task.name}`, subtitle: `branch: ${task.branch} · ${task.worktreePath}` }
}
