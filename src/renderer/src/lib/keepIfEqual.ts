/**
 * A state updater that keeps the previous value when `next` has the same JSON, so React bails out of the
 * re-render. For small polled values (status, tabs) that arrive as fresh objects every few seconds.
 */
export function keepIfEqual<T>(next: T): (prev: T) => T {
  const json = JSON.stringify(next)
  return (prev) => (JSON.stringify(prev) === json ? prev : next)
}
