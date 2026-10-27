import { slugify } from '../../../shared/naming'

/**
 * The names main refuses, checked as they are typed so a dialog can say why before anything is sent. Each returns
 * the reason, or null when the name is fine or empty (the submit button is off then, with nothing to explain).
 */

/** A repo's task, as a new task's name is checked against it. */
export interface ExistingTask {
  name: string
  /** What its branch and folder are named after: the first name it had, as renaming keeps it. */
  slug: string
  archived?: boolean
}

const NEEDS_SLUG = 'Use some letters or numbers: the branch and folder are named after them.'

const archivedNote = (t: { archived?: boolean }): string => (t.archived ? ' (archived)' : '')

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** A new task in a repo with `tasks` (archived ones included): its name and its branch must be free. */
export function newTaskNameError(name: string, tasks: readonly ExistingTask[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const slug = slugify(trimmed)
  if (!slug) return NEEDS_SLUG
  const same = tasks.find((t) => sameName(t.name, trimmed))
  if (same) return `A task named “${same.name}” already exists${archivedNote(same)}.`
  const clash = tasks.find((t) => t.slug === slug)
  if (clash)
    return `The task “${clash.name}”${archivedNote(clash)} already uses the branch this name gives (…/${slug}).`
  return null
}

/** A new theme: its name, and the slug its tasks' branches and folders take, must be free. */
export function newThemeNameError(name: string, themes: readonly { name: string; slug: string }[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const slug = slugify(trimmed)
  if (!slug) return NEEDS_SLUG
  const clash = themes.find((t) => sameName(t.name, trimmed) || t.slug === slug)
  return clash ? `A theme named “${clash.name}” already exists.` : null
}

/**
 * A new display name for a theme or task, among `others` (the other themes, or the repo's other tasks): only
 * the name has to be free, as the slug stays.
 */
export function renameError(
  name: string,
  others: readonly { name: string; archived?: boolean }[],
  what: 'theme' | 'task',
): string | null {
  const clash = name.trim() ? others.find((o) => sameName(o.name, name)) : undefined
  return clash ? `A ${what} named “${clash.name}” already exists${archivedNote(clash)}.` : null
}
