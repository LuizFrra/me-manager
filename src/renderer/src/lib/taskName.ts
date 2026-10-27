import { slugify } from '../../../shared/naming'

/** A repo's task, as a new task's name is checked against it. */
export interface ExistingTask {
  name: string
  /** What its branch and folder are named after: the first name it had, as renaming keeps it. */
  slug: string
  archived?: boolean
}

/**
 * Why main would refuse `name` for a new task in a repo with `tasks` (archived ones included), so the dialog can
 * say so as it is typed; null when it is fine, or empty (Create is off then, with nothing to explain).
 */
export function newTaskNameError(name: string, tasks: readonly ExistingTask[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const slug = slugify(trimmed)
  if (!slug) return 'Use some letters or numbers: the branch and folder are named after them.'
  const archived = (t: ExistingTask): string => (t.archived ? ' (archived)' : '')
  const same = tasks.find((t) => t.name.trim().toLowerCase() === trimmed.toLowerCase())
  if (same) return `A task named “${same.name}” already exists${archived(same)}.`
  const clash = tasks.find((t) => t.slug === slug)
  if (clash) return `The task “${clash.name}”${archived(clash)} already uses the branch this name gives (…/${slug}).`
  return null
}
