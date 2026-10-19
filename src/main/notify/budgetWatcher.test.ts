import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { budgetStatus } from '../../shared/budget'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { AppState, BudgetAlert, BudgetReport, Settings, Task } from '../../shared/types'
import { BudgetAlertStore, type BudgetAlertStoreApi } from '../store/budgetAlerts'
import { emptySentBudgetAlerts } from './budgetAlerts'
import { BUDGET_CHECK_MS, BudgetWatcher } from './budgetWatcher'
import type { DesktopNotice } from './watcher'

const task = (id: string, name: string, archivedAt?: string): Task => ({
  id,
  name,
  slug: id,
  branch: `claude/client-x/${id}`,
  worktreePath: `/wt/${id}`,
  baseRef: 'origin/main',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...(archivedAt ? { archivedAt } : {}),
})

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
          tasks: [task('k1', 'Fix login'), task('k2', 'Old', '2026-02-01T00:00:00.000Z')],
        },
      ],
    },
  ],
}

let file: string

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'mm-budget-watch-')), 'budget-alerts.json')
})

afterEach(() => vi.useRealTimers())

interface Env {
  report: BudgetReport
  settings: Settings
  focused: boolean
  fail: boolean
}

interface Setup {
  watcher: BudgetWatcher
  env: Env
  notify: Mock<(n: DesktopNotice) => void>
  showInApp: Mock<(a: BudgetAlert) => void>
  getBudgets: Mock<() => Promise<BudgetReport>>
}

/** A watcher as main starts it, reading and writing `file` (a fresh store each time, as after a restart). */
function setup(env: Env, store: BudgetAlertStoreApi = new BudgetAlertStore(file)): Setup {
  const notify = vi.fn<(n: DesktopNotice) => void>()
  const showInApp = vi.fn<(a: BudgetAlert) => void>()
  const getBudgets = vi.fn<() => Promise<BudgetReport>>(async () => {
    if (env.fail) throw new Error('usage unreadable')
    return env.report
  })
  const watcher = new BudgetWatcher({
    getBudgets,
    getState: async () => state,
    getSettings: () => env.settings,
    isWindowFocused: () => env.focused,
    notify,
    showInApp,
    store,
    now: () => new Date(2026, 9, 19, 15, 0),
  })
  return { watcher, env, notify, showInApp, getBudgets }
}

const newEnv = (over: Partial<Env> = {}): Env => ({
  report: { daily: null, tasks: {} },
  settings: { ...DEFAULT_SETTINGS, taskBudgetUsd: 5, dailyBudgetUsd: 10 },
  focused: false,
  fail: false,
  ...over,
})

describe('BudgetWatcher', () => {
  it('sends a desktop notification for the task that reached 80%, labelled and selecting it, then for 100%', async () => {
    const { watcher, env, notify, showInApp } = setup(newEnv())
    env.report = { daily: null, tasks: { k1: budgetStatus(3, 5)! } }
    await watcher.tick()
    expect(notify).not.toHaveBeenCalled()
    env.report = { daily: null, tasks: { k1: budgetStatus(4.1, 5)! } }
    await watcher.tick()
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      title: 'Task at 82% of its budget',
      body: 'Client X › my-api › Fix login: $4.10 of $5.00 task budget',
      target: { themeId: 't', itemId: 'r', taskId: 'k1' },
    })
    await watcher.tick()
    expect(notify).toHaveBeenCalledOnce()
    env.report = { daily: null, tasks: { k1: budgetStatus(5, 5)! } }
    await watcher.tick()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.lastCall?.[0].title).toBe('Task over its budget')
    expect(showInApp).not.toHaveBeenCalled() // the window isn't focused
  })

  it("notifies the day's budget without a target, and also in the app while the window is focused", async () => {
    const { watcher, env, notify, showInApp } = setup(newEnv({ focused: true }))
    env.report = { daily: budgetStatus(10, 10)!, tasks: {} }
    await watcher.tick()
    const notice = { title: "Today's budget is used up", body: '$10.00 of $10.00 daily budget (all tasks and folders)' }
    expect(notify).toHaveBeenCalledExactlyOnceWith(notice)
    expect(showInApp).toHaveBeenCalledExactlyOnceWith({ ...notice, level: 'over' })
  })

  it('does not notify again after a restart', async () => {
    const env = newEnv({ report: { daily: budgetStatus(8, 10)!, tasks: { k1: budgetStatus(6, 5)! } } })
    const first = setup(env)
    await first.watcher.tick()
    expect(first.notify).toHaveBeenCalledTimes(2)
    first.watcher.stop()

    const restarted = setup(env) // a new watcher and store on the same file
    await restarted.watcher.tick()
    expect(restarted.notify).not.toHaveBeenCalled()
    env.report = { daily: budgetStatus(10, 10)!, tasks: { k1: budgetStatus(7, 5)! } }
    await restarted.watcher.tick()
    expect(restarted.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Today's budget is used up" }),
    )
  })

  it('skips a task that is gone from the state meanwhile', async () => {
    const { watcher, env, notify } = setup(newEnv())
    env.report = { daily: null, tasks: { gone: budgetStatus(6, 5)! } }
    await watcher.tick()
    expect(notify).not.toHaveBeenCalled()
  })

  it('reads no usage while notifications are off, and notifies what is due once they are on', async () => {
    const env = newEnv({ settings: { ...DEFAULT_SETTINGS, notifications: false, taskBudgetUsd: 5 } })
    env.report = { daily: null, tasks: { k1: budgetStatus(6, 5)! } }
    const { watcher, notify, getBudgets } = setup(env)
    await watcher.tick()
    expect(getBudgets).not.toHaveBeenCalled()
    env.settings = { ...env.settings, notifications: true }
    await watcher.tick()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('survives a failing check and tries again next time', async () => {
    const { watcher, env, notify } = setup(newEnv({ fail: true, report: { daily: budgetStatus(9, 10)!, tasks: {} } }))
    await expect(watcher.tick()).resolves.toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
    env.fail = false
    await watcher.tick()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('checks every BUDGET_CHECK_MS, at most once a minute and at least every 30 s, until stopped', async () => {
    expect(BUDGET_CHECK_MS).toBeGreaterThanOrEqual(30_000)
    expect(BUDGET_CHECK_MS).toBeLessThanOrEqual(60_000)
    vi.useFakeTimers()
    // In memory: file reads would finish outside the fake clock.
    const memory: BudgetAlertStoreApi = { load: async () => emptySentBudgetAlerts(), save: async () => {} }
    const { watcher, getBudgets } = setup(newEnv(), memory)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(getBudgets).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BUDGET_CHECK_MS - 1)
    expect(getBudgets).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getBudgets).toHaveBeenCalledTimes(2)
    watcher.stop()
    await vi.advanceTimersByTimeAsync(BUDGET_CHECK_MS * 3)
    expect(getBudgets).toHaveBeenCalledTimes(2)
  })
})
