import { isArchived, type Task } from './types'

/** `index` kept inside a list of `length` entries (0 for an empty one). */
export const clampIndex = (index: number, length: number): number =>
  Math.min(Math.max(index, 0), Math.max(length - 1, 0))

/**
 * `list` with the entry at `from` moved to index `to` (clamped), so that it ends up at `to` in the result. The
 * same list (not a copy) when nothing moves: `from` is already there, or there is no entry at `from`.
 */
export function moveEntry<T>(list: readonly T[], from: number, to: number): readonly T[] {
  const at = clampIndex(to, list.length)
  if (from < 0 || from >= list.length || at === from) return list
  const next = [...list]
  const [entry] = next.splice(from, 1)
  next.splice(at, 0, entry)
  return next
}

/**
 * A repo's tasks with the active task `taskId` moved to position `to` (clamped) among the active ones, which is
 * how the sidebar lists them. Archived tasks keep their slots, so the "Archived" group keeps its order. The same
 * list when nothing moves, or `taskId` is not an active task of the list.
 */
export function moveActiveTask(tasks: readonly Task[], taskId: string, to: number): readonly Task[] {
  const active = tasks.filter((t) => !isArchived(t))
  const order = moveEntry(
    active,
    active.findIndex((t) => t.id === taskId),
    to,
  )
  if (order === active) return tasks
  let next = 0
  return tasks.map((t) => (isArchived(t) ? t : order[next++]))
}
