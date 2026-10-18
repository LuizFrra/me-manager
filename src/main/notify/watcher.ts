import { targetKey } from '../../shared/naming'
import { allTargets } from '../../shared/targets'
import type { AppState, LiveStatus, Settings, Target } from '../../shared/types'
import { ActivityTransitions, type ActivityNotice } from './transitions'

export interface DesktopNotice {
  title: string
  /** "Theme › Repo › Task" or "Theme › Folder". */
  body: string
  /** Selected when the notification is clicked. */
  target: Target
}

export interface NotificationWatcherDeps {
  getStatus(): Promise<LiveStatus>
  getState(): Promise<AppState>
  getSettings(): Settings
  /** The target the terminal shows (what the user has selected), or null. */
  currentTarget(): Target | null
  isWindowFocused(): boolean
  notify(notice: DesktopNotice): void
  now?: () => number
}

export const NOTICE_TITLES: Record<ActivityNotice['kind'], string> = {
  finished: 'Claude finished',
  waiting: 'Claude needs your input',
}

/**
 * Polls Claude's activity in the main process (the renderer stops polling while the window is hidden, which is
 * exactly when notifications matter) and sends a desktop notification for each transition ActivityTransitions
 * reports. Polls at Settings.pollIntervalMs, and only while Settings.notifications is on.
 */
export class NotificationWatcher {
  private readonly transitions = new ActivityTransitions()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private readonly now: () => number

  constructor(private readonly deps: NotificationWatcherDeps) {
    this.now = deps.now ?? Date.now
  }

  /** One poll. Never throws: a failed poll just waits for the next one. */
  async tick(): Promise<void> {
    try {
      if (!this.deps.getSettings().notifications) {
        this.transitions.reset() // turning them back on starts from a fresh baseline, not stale busy states
        return
      }
      const status = await this.deps.getStatus()
      const current = this.deps.currentTarget()
      const notices = this.transitions.update({
        activity: status.activity,
        selectedKey: current ? targetKey(current) : null,
        focused: this.deps.isWindowFocused(),
        now: this.now(),
      })
      if (notices.length === 0) return
      const entries = new Map(allTargets(await this.deps.getState()).map((e) => [targetKey(e.target), e]))
      for (const notice of notices) {
        const entry = entries.get(notice.key)
        if (entry) this.deps.notify({ title: NOTICE_TITLES[notice.kind], body: entry.label, target: entry.target })
      }
    } catch {
      // tmux or the state may be briefly unavailable; try again next time
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const loop = async (): Promise<void> => {
      await this.tick()
      if (this.stopped) return
      this.timer = setTimeout(() => void loop(), this.deps.getSettings().pollIntervalMs)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
