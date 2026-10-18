import type { ClaudeActivity } from '../../shared/types'

/** At most one notification per task or folder in this window. */
export const NOTIFY_DEBOUNCE_MS = 30_000
/**
 * Claude must have been seen busy for this long (first to last busy poll) before going quiet counts as finishing.
 * A short burst of output is not work: Claude Code redraws when the terminal is detached or loses focus (which is
 * what switching to another task does), and typing in the terminal prints too.
 */
export const MIN_BUSY_MS = 5_000

export interface ActivityNotice {
  /** The target's key (task id or folder id). */
  key: string
  /** busy→idle is `finished`; busy→waiting is `waiting`. */
  kind: 'finished' | 'waiting'
}

export interface ActivitySnapshot {
  /** LiveStatus.activity: running sessions with a claude window, by key. */
  activity: Readonly<Record<string, ClaudeActivity>>
  /** The target the terminal shows, if any. */
  selectedKey: string | null
  /** Whether the app window has focus. */
  focused: boolean
  now: number
}

/**
 * Turns successive activity polls into the notifications to send: when Claude goes from busy to idle or waiting
 * in a task or folder the user is not looking at (another target, or the window is not focused). Pure apart from
 * its own memory; the first snapshot only sets the baseline, so nothing fires at startup.
 */
export class ActivityTransitions {
  private previous: Readonly<Record<string, ClaudeActivity>> | null = null
  /** The current busy streak per key: when it was first and last seen busy. */
  private readonly busy = new Map<string, { since: number; last: number }>()
  private readonly lastNotified = new Map<string, number>()

  update({ activity, selectedKey, focused, now }: ActivitySnapshot): ActivityNotice[] {
    const notices: ActivityNotice[] = []
    for (const [key, next] of Object.entries(activity)) {
      const streak = this.busy.get(key)
      if (next === 'busy') {
        if (streak) streak.last = now
        else this.busy.set(key, { since: now, last: now })
        continue
      }
      this.busy.delete(key)
      if (this.previous?.[key] !== 'busy' || !streak) continue
      if (streak.last - streak.since < MIN_BUSY_MS) continue
      if (key === selectedKey && focused) continue // the user is watching it
      const last = this.lastNotified.get(key)
      if (last !== undefined && now - last < NOTIFY_DEBOUNCE_MS) continue
      this.lastNotified.set(key, now)
      notices.push({ key, kind: next === 'waiting' ? 'waiting' : 'finished' })
    }
    for (const key of this.busy.keys()) if (!(key in activity)) this.busy.delete(key) // session ended
    this.previous = { ...activity }
    return notices
  }

  /** Forgets everything but the debounce times, so the next snapshot is a new baseline (notifications re-enabled). */
  reset(): void {
    this.previous = null
    this.busy.clear()
  }
}
