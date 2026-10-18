import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { AppState, ClaudeActivity, LiveStatus, Settings, Target } from '../../shared/types'
import { MIN_BUSY_MS } from './transitions'
import { NotificationWatcher, type DesktopNotice } from './watcher'

const state: AppState = {
  version: 1,
  themes: [
    {
      id: 't',
      name: 'Client X',
      slug: 'client-x',
      items: [
        {
          id: 'r',
          kind: 'repo',
          name: 'my-api',
          slug: 'my-api',
          path: '/code/my-api',
          tasks: [
            {
              id: 'k',
              name: 'Fix login',
              slug: 'fix-login',
              branch: 'claude/client-x/fix-login',
              worktreePath: '/wt/k',
              baseRef: 'origin/main',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        { id: 'f', kind: 'folder', name: 'notes', slug: 'notes', path: '/notes' },
      ],
    },
  ],
}
const taskTarget: Target = { themeId: 't', itemId: 'r', taskId: 'k' }
const folderTarget: Target = { themeId: 't', itemId: 'f' }

interface Env {
  activity: Record<string, ClaudeActivity>
  settings: Settings
  current: Target | null
  focused: boolean
  failStatus: boolean
}

interface Setup {
  watcher: NotificationWatcher
  env: Env
  notify: Mock<(n: DesktopNotice) => void>
  getStatus: Mock<() => Promise<LiveStatus>>
  /** Polls with these activities, 3 s after the previous poll. */
  poll(activity: Record<string, ClaudeActivity>): Promise<void>
  /** Polls busy long enough to count as work. */
  work(activity: Record<string, ClaudeActivity>): Promise<void>
}

function setup(settings: Partial<Settings> = {}): Setup {
  const clock = { now: 1_000_000 }
  const env: Env = {
    activity: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
    current: null,
    focused: true,
    failStatus: false,
  }
  const notify = vi.fn<(n: DesktopNotice) => void>()
  const getStatus = vi.fn<() => Promise<LiveStatus>>(async () => {
    if (env.failStatus) throw new Error('tmux died')
    return { running: Object.keys(env.activity), missing: [], activity: { ...env.activity } }
  })
  const watcher = new NotificationWatcher({
    getStatus,
    getState: async () => state,
    getSettings: () => env.settings,
    currentTarget: () => env.current,
    isWindowFocused: () => env.focused,
    notify,
    now: () => clock.now,
  })
  const poll = async (activity: Record<string, ClaudeActivity>): Promise<void> => {
    env.activity = activity
    clock.now += 3000
    await watcher.tick()
  }
  const work = async (activity: Record<string, ClaudeActivity>): Promise<void> => {
    for (let ms = 0; ms < MIN_BUSY_MS + 3000; ms += 3000) await poll(activity)
  }
  return { watcher, env, notify, getStatus, poll, work }
}

afterEach(() => vi.useRealTimers())

describe('NotificationWatcher', () => {
  it('notifies "Claude finished" with the target path when a background task goes idle', async () => {
    const { notify, poll, work } = setup()
    await poll({ k: 'idle', f: 'idle' }) // startup: nothing
    await work({ k: 'busy', f: 'idle' })
    expect(notify).not.toHaveBeenCalled()
    await poll({ k: 'idle', f: 'idle' })
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      title: 'Claude finished',
      body: 'Client X › my-api › Fix login',
      target: taskTarget,
    })
  })

  it('notifies "Claude needs your input" for a folder that starts waiting', async () => {
    const { notify, poll, work } = setup()
    await work({ f: 'busy' })
    await poll({ f: 'waiting' })
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      title: 'Claude needs your input',
      body: 'Client X › notes',
      target: folderTarget,
    })
  })

  it('stays quiet for the selected target while the window is focused, and notifies once it is not', async () => {
    const { env, notify, poll, work } = setup()
    env.current = taskTarget
    await work({ k: 'busy' })
    await poll({ k: 'idle' })
    expect(notify).not.toHaveBeenCalled()
    env.focused = false
    await work({ k: 'busy' })
    await poll({ k: 'waiting' })
    expect(notify).toHaveBeenCalledOnce()
  })

  it('does nothing while notifications are off, and starts from a fresh baseline when turned on', async () => {
    const { env, notify, getStatus, poll, work } = setup({ notifications: false })
    await work({ k: 'busy' })
    await poll({ k: 'idle' })
    expect(getStatus).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()

    await poll({ k: 'busy' }) // still off
    env.settings = { ...env.settings, notifications: true }
    await poll({ k: 'idle' }) // first poll after turning on: baseline only
    expect(notify).not.toHaveBeenCalled()
  })

  it('survives a failing poll', async () => {
    const { env, notify, poll, work } = setup()
    await work({ k: 'busy' })
    env.failStatus = true
    await expect(poll({ k: 'idle' })).resolves.toBeUndefined()
    env.failStatus = false
    await poll({ k: 'idle' })
    expect(notify).toHaveBeenCalledOnce()
  })

  it('skips a target that was removed meanwhile', async () => {
    const { notify, poll, work } = setup()
    await work({ gone: 'busy' })
    await poll({ gone: 'idle' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('polls at the poll interval from settings until stopped', async () => {
    vi.useFakeTimers()
    const { watcher, getStatus } = setup({ pollIntervalMs: 2000 })
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getStatus).toHaveBeenCalledTimes(2)
    watcher.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })
})
