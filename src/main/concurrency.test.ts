import { describe, expect, it } from 'vitest'
import { mapLimit } from './concurrency'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

describe('mapLimit', () => {
  it('keeps the order of the items', async () => {
    await expect(mapLimit([3, 1, 2], 2, async (n) => n * 10)).resolves.toEqual([30, 10, 20])
  })

  it('never runs more than `limit` calls at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapLimit([...Array(10).keys()], 4, async () => {
      peak = Math.max(peak, ++inFlight)
      await tick()
      inFlight--
    })
    expect(peak).toBe(4)
  })

  it('handles an empty list', async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([])
  })

  it('rejects when a call rejects', async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})
