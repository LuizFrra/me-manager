import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PANEL_FRACTION, clampFraction, loadPanelFraction, savePanelFraction } from './panelState'

/** Node's built-in `localStorage` shadows jsdom's and is unusable without a file, so tests bring their own. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, String(v)) }
}

describe('panel width storage', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to 40% and round-trips a saved width', () => {
    expect(loadPanelFraction()).toBe(DEFAULT_PANEL_FRACTION)
    savePanelFraction(0.55)
    expect(loadPanelFraction()).toBe(0.55)
  })

  it('ignores garbage and clamps to 70%', () => {
    localStorage.setItem('me-manager.panelWidth', 'nope')
    expect(loadPanelFraction()).toBe(DEFAULT_PANEL_FRACTION)
    localStorage.setItem('me-manager.panelWidth', '0.95')
    expect(loadPanelFraction()).toBe(0.7)
  })

  it('survives storage that throws', () => {
    const denied = (): never => {
      throw new Error('denied')
    }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    expect(() => savePanelFraction(0.5)).not.toThrow()
    expect(loadPanelFraction()).toBe(DEFAULT_PANEL_FRACTION)
  })

  it('clamps to at least 280px of the container', () => {
    expect(clampFraction(0.1, 1000)).toBe(0.28)
    expect(clampFraction(0.5, 1000)).toBe(0.5)
    expect(clampFraction(0.9, 1000)).toBe(0.7)
  })
})
