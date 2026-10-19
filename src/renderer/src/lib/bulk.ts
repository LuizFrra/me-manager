import type { UnsavedWork } from '../../../shared/types'
import { plural } from './gitStatus'
import { cleanError } from './toasts'

/** What the bulk bar and the palette offer for the selected tasks. */
export type BulkAction = 'push' | 'update' | 'archive' | 'remove'

/**
 * Why the bulk Archive leaves a task out: archiving would lose its uncommitted or untracked files, or could not
 * check for them. Archiving it on its own can discard them; a batch never does. Undefined when it can go.
 */
export function archiveSkipReason(work: UnsavedWork | undefined): string | undefined {
  if (work?.warning) return 'it could not be checked for changes'
  if (work && work.uncommittedFiles.length > 0) return 'it has uncommitted or untracked files'
  return undefined
}

/** How one item of a batch went: its value, or what it threw. */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown }

/**
 * Runs `fn` on every item, at most `limit` at a time, starting them in order; settles once all have, with each
 * outcome at its item's index. A failure doesn't stop the rest.
 */
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { ok: true, value: await fn(items[index]) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * How a bulk action went for one task: done, failed (with main's error), skipped before it was tried (with why),
 * or, for Update from base, stopped on conflicts (undone, as for a single task).
 */
export type BulkOutcome = { name: string } & (
  { kind: 'done' } | { kind: 'failed'; reason: unknown } | { kind: 'skipped'; reason: string } | { kind: 'conflict' }
)

/**
 * The one toast a bulk action ends with: "Pushed 4 tasks" when all went well; otherwise how many of them, then why
 * each other one did not: "Pushed 3 of 4 tasks; fix-login failed: <reason>". `ok`: all went well.
 */
export function bulkSummary(verb: string, outcomes: readonly BulkOutcome[]): { message: string; ok: boolean } {
  const done = outcomes.filter((o) => o.kind === 'done').length
  if (done === outcomes.length) return { message: `${verb} ${plural(done, 'task')}`, ok: true }
  const parts = [`${verb} ${done} of ${plural(outcomes.length, 'task')}`]
  const conflicts = outcomes.filter((o) => o.kind === 'conflict').map((o) => o.name)
  if (conflicts.length > 0)
    parts.push(
      `conflicts in ${conflicts.join(', ')} (undone: run Update from base on ${conflicts.length === 1 ? 'it' : 'each'} to resolve)`,
    )
  for (const o of outcomes) {
    if (o.kind === 'skipped') parts.push(`skipped ${o.name}: ${o.reason}`)
    else if (o.kind === 'failed') parts.push(`${o.name} failed: ${cleanError(o.reason)}`)
  }
  return { message: parts.join('; '), ok: false }
}
