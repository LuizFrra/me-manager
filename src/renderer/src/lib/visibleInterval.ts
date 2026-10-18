export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Like setInterval, but:
 * - skips ticks while the page is hidden (window minimized or in the background) and runs once
 *   immediately when it becomes visible again, so the UI is fresh on return;
 * - if `fn` returns a promise, skips ticks until it settles, so slow polls never pile up.
 * Returns a function that stops the interval.
 */
export function startVisibleInterval(
  fn: () => void | Promise<unknown>,
  ms: number,
  doc: VisibilitySource = document,
): () => void {
  let inFlight = false
  const tick = (): void => {
    if (doc.hidden || inFlight) return
    const result = fn()
    if (result instanceof Promise) {
      inFlight = true
      result.then(
        () => (inFlight = false),
        () => (inFlight = false),
      )
    }
  }
  const id = setInterval(tick, ms)
  doc.addEventListener('visibilitychange', tick)
  return () => {
    clearInterval(id)
    doc.removeEventListener('visibilitychange', tick)
  }
}
