import type { AppState, Target } from '../../../shared/types'

export interface TargetEntry {
  target: Target
  kind: 'task' | 'folder'
  /** "Theme › Repo › Task" or "Theme › Folder". */
  label: string
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
        })
        continue
      }
      for (const task of item.tasks)
        entries.push({
          target: { themeId: theme.id, itemId: item.id, taskId: task.id },
          kind: 'task',
          label: `${theme.name} › ${item.name} › ${task.name}`,
        })
    }
  return entries
}

/**
 * The tasks and folders the sidebar shows, in order: what Mod+1..9 counts. Entries inside a collapsed theme
 * or repo are hidden, so they are skipped.
 */
export function visibleTargets(state: AppState, collapsed: ReadonlySet<string>): Target[] {
  return allTargets(state)
    .filter((e) => !collapsed.has(e.target.themeId) && (e.kind === 'folder' || !collapsed.has(e.target.itemId)))
    .map((e) => e.target)
}
