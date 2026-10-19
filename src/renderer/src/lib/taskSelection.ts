import { isArchived, type AppState, type Target, type Task } from '../../../shared/types'
import type { SidebarFilter } from './sidebarFilter'
import { visibleTargets } from './targets'

/**
 * The multi-selection of the sidebar's tasks, for the bulk actions: a set of task ids. Only active tasks take part
 * (an archived one has no worktree to push, update or archive). Mod+click and Space toggle a task; Shift+click and
 * Shift+↑/↓ select a range, which never leaves the repo of the task clicked: bulk actions span repos through
 * Mod+click, but a range is "these tasks of this repo".
 */

/** A task row the sidebar shows: an active task whose theme and repo are expanded, and that the filter keeps. */
export interface TaskRow {
  taskId: string
  repoId: string
}

/** The task rows the sidebar shows, in order: what ranges and Shift+↑/↓ run over. */
export function taskRows(
  state: AppState,
  collapsed: ReadonlySet<string>,
  filter: SidebarFilter | null = null,
): TaskRow[] {
  return visibleTargets(state, collapsed, filter).flatMap((t) =>
    t.taskId === undefined ? [] : [{ taskId: t.taskId, repoId: t.itemId }],
  )
}

/**
 * The selection with task `id` toggled in or out. The first task toggled into an empty selection brings the
 * current task (`current`) with it, so a click on one task and a Mod+click on another selects both.
 */
export function toggleTask(selection: ReadonlySet<string>, id: string, current?: string): ReadonlySet<string> {
  const next = new Set(selection.size === 0 && current !== undefined && current !== id ? [current] : selection)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * The tasks from `anchor` to `id`, both included, in sidebar order, within `id`'s repo. An anchor in another repo
 * stands for the end of `id`'s repo nearest to it: Shift+click on a task below one in another repo selects from the
 * top of its own repo down to it. Just `id` without an anchor the sidebar shows; nothing when `id` isn't shown.
 */
export function rangeOf(rows: readonly TaskRow[], anchor: string | undefined, id: string): string[] {
  const row = rows.find((r) => r.taskId === id)
  if (!row) return []
  const repo = rows.filter((r) => r.repoId === row.repoId).map((r) => r.taskId)
  const to = repo.indexOf(id)
  const anchorAt = rows.findIndex((r) => r.taskId === anchor)
  if (anchorAt === -1) return [id]
  const from =
    rows[anchorAt].repoId === row.repoId
      ? repo.indexOf(rows[anchorAt].taskId)
      : anchorAt < rows.indexOf(row)
        ? 0
        : repo.length - 1
  return repo.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/** The task row `step` rows above (-1) or below (1) `id` in its repo; undefined past either end. */
export function neighbourTask(rows: readonly TaskRow[], id: string, step: -1 | 1): string | undefined {
  const row = rows.find((r) => r.taskId === id)
  if (!row) return undefined
  const repo = rows.filter((r) => r.repoId === row.repoId)
  return repo[repo.indexOf(row) + step]?.taskId
}

/** The ids of every active task in `state`. */
function activeTaskIds(state: AppState): Set<string> {
  const ids = new Set<string>()
  for (const theme of state.themes)
    for (const item of theme.items)
      if (item.kind === 'repo') for (const task of item.tasks) if (!isArchived(task)) ids.add(task.id)
  return ids
}

/**
 * The selection without the tasks that are gone or archived since (after a bulk Remove or Archive, say); the same
 * set when none are.
 */
export function pruneSelection(state: AppState, selection: ReadonlySet<string>): ReadonlySet<string> {
  const active = activeTaskIds(state)
  return [...selection].every((id) => active.has(id))
    ? selection
    : new Set([...selection].filter((id) => active.has(id)))
}

/** A selected task, as the bulk actions need it. */
export interface SelectedTask {
  target: Target
  task: Task
  repoName: string
}

/** The selected active tasks, in sidebar order. */
export function selectedTasks(state: AppState, selection: ReadonlySet<string>): SelectedTask[] {
  const found: SelectedTask[] = []
  for (const theme of state.themes)
    for (const item of theme.items) {
      if (item.kind !== 'repo') continue
      for (const task of item.tasks)
        if (selection.has(task.id) && !isArchived(task))
          found.push({ target: { themeId: theme.id, itemId: item.id, taskId: task.id }, task, repoName: item.name })
    }
  return found
}
