import { describe, expect, it, vi } from 'vitest'
import { debounceSettled, type FrameTimers } from './settledResize'

/** Manual frames and timers: `frame()` runs pending animation frames, `advance(ms)` moves the clock. */
function fakeTimers(): FrameTimers & { frame: () => void; advance: (ms: number) => void } {
  let now = 0
  let nextId = 1
  const frames = new Map<number, () => void>()
  const timeouts = new Map<number, { at: number; cb: () => void }>()
  return {
    requestFrame: (cb) => {
      const id = nextId++
      frames.set(id, cb)
      return id
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimeout: (cb, ms) => {
      const id = nextId++
      timeouts.set(id, { at: now + ms, cb })
      return id
    },
    clearTimeout: (id) => void timeouts.delete(id),
    frame: () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((cb) => cb())
    },
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timeouts]) {
        if (t.at <= now) {
          timeouts.delete(id)
          t.cb()
        }
      }
    },
  }
}

describe('debounceSettled', () => {
  it('runs once, a frame and the delay after the last call', () => {
    const timers = fakeTimers()
    const fn = vi.fn()
    const d = debounceSettled(fn, 100, timers)
    for (let i = 0; i < 20; i++) {
      d.schedule()
      timers.frame()
      timers.advance(16)
    }
    expect(fn).not.toHaveBeenCalled()
    timers.advance(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('waits for the next animation frame before starting the delay', () => {
    const timers = fakeTimers()
    const fn = vi.fn()
    const d = debounceSettled(fn, 100, timers)
    d.schedule()
    timers.advance(500)
    expect(fn).not.toHaveBeenCalled()
    timers.frame()
    timers.advance(99)
    expect(fn).not.toHaveBeenCalled()
    timers.advance(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('can be scheduled again after it ran', () => {
    const timers = fakeTimers()
    const fn = vi.fn()
    const d = debounceSettled(fn, 100, timers)
    d.schedule()
    timers.frame()
    timers.advance(100)
    d.schedule()
    timers.frame()
    timers.advance(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does nothing after cancel', () => {
    const timers = fakeTimers()
    const fn = vi.fn()
    const d = debounceSettled(fn, 100, timers)
    d.schedule()
    d.cancel()
    timers.frame()
    timers.advance(1000)
    d.schedule()
    timers.frame()
    d.cancel()
    timers.advance(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})
