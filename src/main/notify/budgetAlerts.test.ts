import { describe, expect, it } from 'vitest'
import { budgetStatus } from '../../shared/budget'
import type { BudgetReport, BudgetStatus } from '../../shared/types'
import {
  budgetCrossings,
  budgetNotice,
  emptySentBudgetAlerts,
  localDay,
  normalizeSentBudgetAlerts,
  type SentBudgetAlerts,
} from './budgetAlerts'

const DAY = '2026-10-19'
const status = (spent: number, limit: number): BudgetStatus => budgetStatus(spent, limit)!
const report = (tasks: Record<string, BudgetStatus>, daily: BudgetStatus | null = null): BudgetReport => ({
  daily,
  tasks,
})
const known = new Set(['k1', 'k2'])

/** Runs the polls one after the other, as the watcher does, and returns the levels each one notified. */
function run(polls: BudgetReport[], start: SentBudgetAlerts = emptySentBudgetAlerts(), day = DAY): string[][] {
  let sent = start
  return polls.map((r) => {
    const result = budgetCrossings(r, sent, day, known)
    sent = result.sent
    return result.crossings.map((c) => `${c.taskId ?? 'daily'}:${c.status.level}`)
  })
}

describe('budgetCrossings', () => {
  it("notifies a task's 80% once, then its 100% once, and nothing after", () => {
    expect(
      run([
        report({ k1: status(1, 5) }),
        report({ k1: status(4, 5) }),
        report({ k1: status(4.5, 5) }),
        report({ k1: status(5.1, 5) }),
        report({ k1: status(9, 5) }),
      ]),
    ).toEqual([[], ['k1:warn'], [], ['k1:over'], []])
  })

  it('notifies only the highest threshold crossed since the last poll', () => {
    expect(run([report({ k1: status(1, 5) }), report({ k1: status(6, 5) }), report({ k1: status(6, 5) })])).toEqual([
      [],
      ['k1:over'],
      [],
    ])
  })

  it('starts afresh when the limit changes', () => {
    expect(
      run([
        report({ k1: status(5, 5) }),
        report({ k1: status(5, 10) }), // raised: under 80% of the new one
        report({ k1: status(8, 10) }),
        report({ k1: status(8, 5) }), // lowered below what is spent
      ]),
    ).toEqual([['k1:over'], [], ['k1:warn'], ['k1:over']])
  })

  it("notifies the day's 80% and 100% once per day, and again the next day", () => {
    let sent = emptySentBudgetAlerts()
    const levels = (r: BudgetReport, day: string): string[] => {
      const result = budgetCrossings(r, sent, day, known)
      sent = result.sent
      return result.crossings.map((c) => `${c.scope}:${c.status.level}`)
    }
    expect(levels(report({}, status(8, 10)), DAY)).toEqual(['daily:warn'])
    expect(levels(report({}, status(9, 10)), DAY)).toEqual([])
    expect(levels(report({}, status(10, 10)), DAY)).toEqual(['daily:over'])
    expect(levels(report({}, status(12, 10)), DAY)).toEqual([])
    expect(levels(report({}, status(0.5, 10)), '2026-10-20')).toEqual([])
    expect(levels(report({}, status(8.5, 10)), '2026-10-20')).toEqual(['daily:warn'])
  })

  it('keeps what was sent for tasks still in the state, and forgets removed ones and stale days', () => {
    const start: SentBudgetAlerts = {
      version: 1,
      daily: { day: '2026-10-18', limit: 10, level: 'over' },
      tasks: { k1: { limit: 5, level: 'over' }, gone: { limit: 5, level: 'warn' } },
    }
    // k1 is archived or lost its budget: not in the report, but still a task.
    const { sent, changed, crossings } = budgetCrossings(report({}), start, DAY, known)
    expect(crossings).toEqual([])
    expect(changed).toBe(true)
    expect(sent).toEqual({ version: 1, tasks: { k1: { limit: 5, level: 'over' } } })
    // k1 comes back (restored) with the same budget: nothing new to say.
    expect(budgetCrossings(report({ k1: status(6, 5) }), sent, DAY, known).crossings).toEqual([])
  })

  it('reports no change when there is nothing new, and never changes what it is given', () => {
    const first = budgetCrossings(report({ k1: status(4, 5) }, status(9, 10)), emptySentBudgetAlerts(), DAY, known)
    expect(first.changed).toBe(true)
    const copy = structuredClone(first.sent)
    const again = budgetCrossings(report({ k1: status(4.2, 5) }, status(9.5, 10)), first.sent, DAY, known)
    expect(again).toEqual({ crossings: [], sent: first.sent, changed: false })
    expect(first.sent).toEqual(copy)
    expect(budgetCrossings(report({ k2: status(1, 5) }), emptySentBudgetAlerts(), DAY, known).changed).toBe(false)
  })
})

describe('normalizeSentBudgetAlerts', () => {
  it('keeps valid entries and drops the rest', () => {
    expect(
      normalizeSentBudgetAlerts({
        version: 1,
        daily: { day: DAY, limit: 10, level: 'warn' },
        tasks: {
          k1: { limit: 5, level: 'over' },
          k2: { limit: -1, level: 'over' },
          k3: { limit: 5, level: 'ok' },
          k4: 'x',
        },
        extra: true,
      }),
    ).toEqual({ version: 1, daily: { day: DAY, limit: 10, level: 'warn' }, tasks: { k1: { limit: 5, level: 'over' } } })
    expect(
      normalizeSentBudgetAlerts({ version: 1, daily: { day: 'today', limit: 1, level: 'warn' }, tasks: [] }),
    ).toEqual(emptySentBudgetAlerts())
    for (const raw of [null, 'x', [], { version: 2 }])
      expect(normalizeSentBudgetAlerts(raw)).toEqual(emptySentBudgetAlerts())
  })
})

describe('budgetNotice', () => {
  it("words a task's crossing with its label, and the day's", () => {
    expect(
      budgetNotice({ scope: 'task', taskId: 'k1', status: status(4.1, 5) }, 'Client X › my-api › Fix login'),
    ).toEqual({
      title: 'Task at 82% of its budget',
      body: 'Client X › my-api › Fix login: $4.10 of $5.00 task budget',
    })
    expect(budgetNotice({ scope: 'task', taskId: 'k1', status: status(5.5, 5) }, 'Fix login')).toEqual({
      title: 'Task over its budget',
      body: 'Fix login: $5.50 of $5.00 task budget',
    })
    expect(budgetNotice({ scope: 'daily', status: status(8, 10) })).toEqual({
      title: "80% of today's budget used",
      body: '$8.00 of $10.00 daily budget (all tasks and folders)',
    })
    expect(budgetNotice({ scope: 'daily', status: status(10, 10) })).toEqual({
      title: "Today's budget is used up",
      body: '$10.00 of $10.00 daily budget (all tasks and folders)',
    })
  })
})

describe('localDay', () => {
  it('is the local date', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDay(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31')
  })
})
