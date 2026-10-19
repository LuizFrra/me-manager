import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { Appearance, Settings } from '../shared/types'
import { followAppearance, type NativeThemeLike } from './appearance'

/** nativeTheme as Electron has it: the OS prefers `systemDark`, themeSource overrides it. */
function fakeTheme(systemDark: boolean): NativeThemeLike & { systemDark: boolean; emit(): void } {
  const listeners: (() => void)[] = []
  return {
    systemDark,
    themeSource: 'system' as Appearance,
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? this.systemDark : this.themeSource === 'dark'
    },
    on(_event: 'updated', listener: () => void) {
      listeners.push(listener)
    },
    emit: () => listeners.forEach((l) => l()),
  }
}

function fakeSettings(appearance: Appearance): {
  get(): Settings
  onChange(l: (s: Settings) => void): () => void
  change(appearance: Appearance): void
} {
  let current: Settings = { ...DEFAULT_SETTINGS, appearance }
  const listeners: ((s: Settings) => void)[] = []
  return {
    get: () => current,
    onChange: (l) => {
      listeners.push(l)
      return () => {}
    },
    change(next) {
      current = { ...current, appearance: next }
      listeners.forEach((l) => l(current))
    },
  }
}

describe('followAppearance', () => {
  it('sets themeSource from the saved setting at once and returns the window background for it', () => {
    const theme = fakeTheme(true)
    const background = followAppearance({ theme, settings: fakeSettings('light'), getWindow: () => null })
    expect(theme.themeSource).toBe('light')
    expect(background()).toBe('#ffffff')
    expect(
      followAppearance({ theme: fakeTheme(true), settings: fakeSettings('system'), getWindow: () => null })(),
    ).toBe('#1e1e1e')
  })

  it('follows a changed setting, and repaints the window background whenever the colours change', () => {
    const theme = fakeTheme(false)
    const settings = fakeSettings('dark')
    const painted: string[] = []
    const win = { setBackgroundColor: (c: string) => painted.push(c) }
    followAppearance({ theme, settings, getWindow: () => win })
    settings.change('system')
    expect(theme.themeSource).toBe('system')
    theme.emit() // Electron emits 'updated' once the colours changed
    expect(painted).toEqual(['#ffffff'])
    theme.systemDark = true
    theme.emit()
    expect(painted).toEqual(['#ffffff', '#1e1e1e'])
  })
})
