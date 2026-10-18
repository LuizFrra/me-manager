import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVisibleInterval, type VisibilitySource } from './visibleInterval'

class FakeDoc extends EventTarget implements VisibilitySource {
  hidden = false
  setHidden(hidden: boolean): void {
    this.hidden = hidden
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

describe('startVisibleInterval', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ticks on the interval while visible', () => {
    const doc = new FakeDoc()
    const fn = vi.fn()
    const stop = startVisibleInterval(fn, 1000, doc)
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(3)
    stop()
  })

  it('skips ticks while hidden', () => {
    const doc = new FakeDoc()
    const fn = vi.fn()
    const stop = startVisibleInterval(fn, 1000, doc)
    doc.setHidden(true)
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
    stop()
  })

  it('runs immediately when the page becomes visible again', () => {
    const doc = new FakeDoc()
    const fn = vi.fn()
    const stop = startVisibleInterval(fn, 1000, doc)
    doc.setHidden(true)
    vi.advanceTimersByTime(5000)
    doc.setHidden(false)
    expect(fn).toHaveBeenCalledTimes(1)
    stop()
  })

  it('skips ticks while a previous async run is still in flight', async () => {
    const doc = new FakeDoc()
    let release: () => void = () => {}
    const fn = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const stop = startVisibleInterval(fn, 1000, doc)
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
  })

  it('keeps ticking after an async run rejects', async () => {
    const doc = new FakeDoc()
    const fn = vi.fn(() => Promise.reject(new Error('boom')))
    const stop = startVisibleInterval(fn, 1000, doc)
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stops ticking and listening after stop()', () => {
    const doc = new FakeDoc()
    const fn = vi.fn()
    const stop = startVisibleInterval(fn, 1000, doc)
    stop()
    vi.advanceTimersByTime(5000)
    doc.setHidden(true)
    doc.setHidden(false)
    expect(fn).not.toHaveBeenCalled()
  })
})
