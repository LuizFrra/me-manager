import type { AppState, Target } from '../../../shared/types'
import { allTargets, type TargetEntry } from '../../../shared/targets'
import type { SidebarFilter } from './sidebarFilter'

export { allTargets, type TargetEntry }

/**
 * The tasks and folders the sidebar shows, in order: what Alt+1..9 (Cmd+1..9 on macOS) counts. Without a filter, entries inside a
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
