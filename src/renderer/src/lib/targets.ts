import type { AppState, Target } from '../../../shared/types'
import type { SidebarFilter } from './sidebarFilter'

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
 * The tasks and folders the sidebar shows, in order: what Mod+1..9 counts. Without a filter, entries inside a
 * collapsed theme or repo are hidden; with one, only matches show and every group is expanded.
 */
export function visibleTargets(
  state: AppState,
  collapsed: ReadonlySet<string>,
  filter: SidebarFilter | null = null,
): Target[] {
  const visible = filter
    ? (e: TargetEntry): boolean =>
        e.target.taskId !== undefined ? filter.tasks.has(e.target.taskId) : filter.items.has(e.target.itemId)
    : (e: TargetEntry): boolean =>
        !collapsed.has(e.target.themeId) && (e.kind === 'folder' || !collapsed.has(e.target.itemId))
  return allTargets(state)
    .filter(visible)
    .map((e) => e.target)
}
