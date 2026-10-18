import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoDiffLayout, loadDiffLayout, saveDiffLayout, SPLIT_MIN_WIDTH } from './layout'

/** Node's built-in `localStorage` shadows jsdom's and is unusable without a file, so tests bring their own. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, String(v)) }
}

describe('diff layout', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('splits only wider than SPLIT_MIN_WIDTH', () => {
    expect(autoDiffLayout(SPLIT_MIN_WIDTH + 1)).toBe('split')
    expect(autoDiffLayout(SPLIT_MIN_WIDTH)).toBe('unified')
    expect(autoDiffLayout(0)).toBe('unified')
  })

  it('remembers the last choice, and has none at first or for junk', () => {
    expect(loadDiffLayout()).toBeNull()
    saveDiffLayout('split')
    expect(loadDiffLayout()).toBe('split')
    saveDiffLayout('unified')
    expect(loadDiffLayout()).toBe('unified')
    localStorage.setItem('me-manager.diffLayout', 'sideways')
    expect(loadDiffLayout()).toBeNull()
  })

  it('works without storage', () => {
    const denied = (): never => {
      throw new Error('denied')
    }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    expect(() => saveDiffLayout('split')).not.toThrow()
    expect(loadDiffLayout()).toBeNull()
  })
})
