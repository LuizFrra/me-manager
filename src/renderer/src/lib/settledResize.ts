export interface FrameTimers {
  requestFrame(cb: () => void): number
  cancelFrame(id: number): void
  setTimeout(cb: () => void, ms: number): number
  clearTimeout(id: number): void
}

const browserTimers: FrameTimers = {
  requestFrame: (cb) => window.requestAnimationFrame(cb),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (id) => window.clearTimeout(id),
}

export interface Debounced {
  /** Asks for a run; restarts the wait if one is already pending. */
  schedule(): void
  /** Drops a pending run. */
  cancel(): void
}

/**
 * Runs `fn` once things have settled: on the animation frame after the last `schedule()`, plus `delayMs` without
 * another call. For work that must not run on every step of a drag, like resizing the pty (each resize is a
 * SIGWINCH to the program in the terminal).
 */
export function debounceSettled(fn: () => void, delayMs: number, timers: FrameTimers = browserTimers): Debounced {
  let frame: number | undefined
  let timer: number | undefined
  const cancel = (): void => {
    if (frame !== undefined) timers.cancelFrame(frame)
    if (timer !== undefined) timers.clearTimeout(timer)
    frame = timer = undefined
  }
  const schedule = (): void => {
    cancel()
    frame = timers.requestFrame(() => {
      frame = undefined
      timer = timers.setTimeout(() => {
        timer = undefined
        fn()
      }, delayMs)
    })
  }
  return { schedule, cancel }
}
