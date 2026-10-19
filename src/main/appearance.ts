import { APPEARANCE_BACKGROUND } from '../shared/appearance'
import type { Appearance, Settings } from '../shared/types'

/** The part of Electron's nativeTheme used here. */
export interface NativeThemeLike {
  themeSource: Appearance
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

/**
 * Keeps nativeTheme.themeSource on Settings.appearance, now and after each change. Chromium's prefers-color-scheme
 * follows it, so the page's CSS starts in the right colours before the renderer has the settings, and the native
 * menus and dialogs match. The window's background colour is repainted whenever the colours change (a new setting,
 * or the OS switching while it is 'system'). Returns the background a new window should have.
 */
export function followAppearance(deps: {
  theme: NativeThemeLike
  settings: { get(): Settings; onChange(listener: (settings: Settings) => void): unknown }
  getWindow: () => { setBackgroundColor(color: string): void } | null
}): () => string {
  const { theme, settings, getWindow } = deps
  const background = (): string => APPEARANCE_BACKGROUND[theme.shouldUseDarkColors ? 'dark' : 'light']
  theme.themeSource = settings.get().appearance
  settings.onChange((s) => {
    if (theme.themeSource !== s.appearance) theme.themeSource = s.appearance
  })
  theme.on('updated', () => getWindow()?.setBackgroundColor(background()))
  return background
}
