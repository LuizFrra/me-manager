import { describe, expect, it } from 'vitest'
import { bulkSummary, runLimited } from './bulk'

describe('runLimited', () => {
  it('runs every item, at most `limit` at once, and settles each in input order', async () => {
    let running = 0
    let most = 0
    const results = await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, n === 1 ? 20 : 1))
      running--
      if (n === 3) throw new Error('three failed')
      return n * 10
    })
    expect(most).toBe(2)
    expect(results).toEqual([
      { ok: true, value: 10 },
      { ok: true, value: 20 },
      { ok: false, error: new Error('three failed') },
      { ok: true, value: 40 },
      { ok: true, value: 50 },
    ])
  })

  it('runs one after another with a limit of 1, and takes no items', async () => {
    const order: string[] = []
    await runLimited(['a', 'b', 'c'], 1, async (s) => {
      order.push(`start ${s}`)
      await Promise.resolve()
      order.push(`end ${s}`)
    })
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(await runLimited([], 3, async () => 1)).toEqual([])
  })
})

describe('bulkSummary', () => {
  it('counts the tasks when all went well', () => {
    expect(bulkSummary('Pushed', [{ name: 'a', kind: 'done' }])).toEqual({ message: 'Pushed 1 task', ok: true })
    expect(
      bulkSummary('Pushed', [
        { name: 'a', kind: 'done' },
        { name: 'b', kind: 'done' },
      ]),
    ).toEqual({ message: 'Pushed 2 tasks', ok: true })
  })

  it('says how many of them, and why each of the others did not', () => {
    expect(
      bulkSummary('Pushed', [
        { name: 'a', kind: 'done' },
        { name: 'fix-login', kind: 'failed', reason: "Error invoking remote method 'api:pushTask': Error: rejected" },
        { name: 'b', kind: 'done' },
        { name: 'c', kind: 'done' },
      ]),
    ).toEqual({ message: 'Pushed 3 of 4 tasks; fix-login failed: rejected', ok: false })
    expect(
      bulkSummary('Archived', [
        { name: 'a', kind: 'skipped', reason: 'it has uncommitted changes' },
        { name: 'b', kind: 'failed', reason: 'gone' },
      ]).message,
    ).toBe('Archived 0 of 2 tasks; skipped a: it has uncommitted changes; b failed: gone')
  })

  it('names the tasks that stopped on conflicts together', () => {
    expect(
      bulkSummary('Updated', [
        { name: 'a', kind: 'done' },
        { name: 'b', kind: 'conflict' },
        { name: 'c', kind: 'failed', reason: 'dirty' },
        { name: 'd', kind: 'conflict' },
      ]).message,
    ).toBe('Updated 1 of 4 tasks; conflicts in b, d (undone: run Update from base on each to resolve); c failed: dirty')
    expect(bulkSummary('Updated', [{ name: 'b', kind: 'conflict' }]).message).toBe(
      'Updated 0 of 1 task; conflicts in b (undone: run Update from base on it to resolve)',
    )
  })
})
