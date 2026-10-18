import { describe, expect, it } from 'vitest'
import type { ClaudeActivity } from '../../shared/types'
import { ActivityTransitions, MIN_BUSY_MS, NOTIFY_DEBOUNCE_MS, type ActivityNotice } from './transitions'

interface Feeder {
  t: ActivityTransitions
  step(
    activity: Record<string, ClaudeActivity>,
    opts?: { selectedKey?: string | null; focused?: boolean },
  ): ActivityNotice[]
  advance(ms: number): void
}

/** Feeds snapshots 3 s apart, like the default poll. */
function feeder(selectedKey: string | null = null, focused = true): Feeder {
  const t = new ActivityTransitions()
  let now = 1_000_000
  return {
    t,
    step(activity, opts = {}) {
      now += 3000
      return t.update({
        activity,
        selectedKey: opts.selectedKey === undefined ? selectedKey : opts.selectedKey,
        focused: opts.focused ?? focused,
        now,
      })
    },
    advance(ms) {
      now += ms
    },
  }
}

/** Busy long enough to count as work. */
const workOn = (f: Feeder, key: string): void => {
  for (let ms = 0; ms < MIN_BUSY_MS + 3000; ms += 3000) f.step({ [key]: 'busy' })
}

describe('ActivityTransitions', () => {
  it('sends nothing for the first snapshot (app startup), whatever the states', () => {
    const f = feeder()
    expect(f.step({ a: 'idle', b: 'waiting', c: 'busy' })).toEqual([])
    expect(f.step({ a: 'idle', b: 'waiting', c: 'busy' })).toEqual([])
  })

  it('notifies busy→idle as finished and busy→waiting as waiting, for targets not selected', () => {
    const f = feeder('other')
    workOn(f, 'a')
    expect(f.step({ a: 'idle' })).toEqual([{ key: 'a', kind: 'finished' }])
    workOn(f, 'b')
    expect(f.step({ b: 'waiting' })).toEqual([{ key: 'b', kind: 'waiting' }])
  })

  it('stays quiet for the selected target while the window is focused, but not when it is unfocused', () => {
    const f = feeder('a', true)
    workOn(f, 'a')
    expect(f.step({ a: 'idle' })).toEqual([])
    workOn(f, 'a')
    expect(f.step({ a: 'idle' }, { focused: false })).toEqual([{ key: 'a', kind: 'finished' }])
  })

  it('ignores transitions that did not start from busy', () => {
    const f = feeder()
    f.step({ a: 'idle' })
    expect(f.step({ a: 'waiting' })).toEqual([])
    expect(f.step({ a: 'idle' })).toEqual([])
  })

  it(`ignores a busy burst shorter than ${MIN_BUSY_MS} ms (a redraw after switching away, typing)`, () => {
    const f = feeder()
    f.step({ a: 'idle' })
    f.step({ a: 'busy' })
    f.step({ a: 'busy' }) // seen 3 s apart: still a burst
    expect(f.step({ a: 'idle' })).toEqual([])
  })

  it(`sends at most one notification per target every ${NOTIFY_DEBOUNCE_MS / 1000} s`, () => {
    const f = feeder()
    workOn(f, 'a')
    expect(f.step({ a: 'idle' })).toHaveLength(1)
    workOn(f, 'a')
    expect(f.step({ a: 'waiting' })).toEqual([]) // within 30 s of the last one
    f.advance(NOTIFY_DEBOUNCE_MS)
    workOn(f, 'a')
    expect(f.step({ a: 'idle' })).toEqual([{ key: 'a', kind: 'finished' }])
  })

  it('debounces per target, not globally', () => {
    const f = feeder()
    workOn(f, 'a')
    expect(f.step({ a: 'idle', b: 'busy' })).toEqual([{ key: 'a', kind: 'finished' }])
    for (let i = 0; i < 2; i++) f.step({ a: 'idle', b: 'busy' })
    expect(f.step({ a: 'idle', b: 'idle' })).toEqual([{ key: 'b', kind: 'finished' }])
  })

  it('forgets a busy session that ended', () => {
    const f = feeder()
    workOn(f, 'a')
    f.step({}) // the session was killed
    expect(f.step({ a: 'idle' })).toEqual([])
  })

  it('starts from a new baseline after reset (notifications turned back on)', () => {
    const f = feeder()
    workOn(f, 'a')
    f.t.reset()
    expect(f.step({ a: 'idle' })).toEqual([])
  })
})
