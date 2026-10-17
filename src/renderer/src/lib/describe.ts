import type { AppState, Target } from '../../../shared/types'

/** Header text for the selected target, or null if it no longer exists. */
export function describeTarget(state: AppState, target: Target): { title: string; subtitle: string } | null {
  const theme = state.themes.find((t) => t.id === target.themeId)
  const item = theme?.items.find((i) => i.id === target.itemId)
  if (!theme || !item) return null
  if (item.kind === 'folder') return { title: `${theme.name} › ${item.name}`, subtitle: item.path }
  const task = item.tasks.find((t) => t.id === target.taskId)
  if (!task) return null
  return { title: `${item.name} › ${task.name}`, subtitle: `branch: ${task.branch} · ${task.worktreePath}` }
}
