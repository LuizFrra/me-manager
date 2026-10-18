import type { AppState, Target } from './types'

export interface TargetEntry {
  target: Target
  kind: 'task' | 'folder'
  /** "Theme › Repo › Task" or "Theme › Folder". */
  label: string
  /** The theme's icon, if it has one. */
  icon?: string
}

/** Every task and folder, in sidebar order (themes, then their items, then a repo's tasks). */
export function allTargets(state: AppState): TargetEntry[] {
  const entries: TargetEntry[] = []
  for (const theme of state.themes)
    for (const item of theme.items) {
      if (item.kind === 'folder') {
        entries.push({
          target: { themeId: theme.id, itemId: item.id },
          kind: 'folder',
          label: `${theme.name} › ${item.name}`,
          ...(theme.icon ? { icon: theme.icon } : {}),
        })
        continue
      }
      for (const task of item.tasks)
        entries.push({
          target: { themeId: theme.id, itemId: item.id, taskId: task.id },
          kind: 'task',
          label: `${theme.name} › ${item.name} › ${task.name}`,
          ...(theme.icon ? { icon: theme.icon } : {}),
        })
    }
  return entries
}
