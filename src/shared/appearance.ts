import type { Appearance, ResolvedAppearance } from './types'

/**
 * The page background (the CSS --bg, also the terminal's) in each appearance: main gives the window this colour so
 * nothing flashes before the first paint.
 */
export const APPEARANCE_BACKGROUND: Readonly<Record<ResolvedAppearance, string>> = Object.freeze({
  dark: '#1e1e1e',
  light: '#ffffff',
})

/** What `appearance` draws in, `systemDark` being whether the OS prefers dark colours. */
export function resolveAppearance(appearance: Appearance, systemDark: boolean): ResolvedAppearance {
  if (appearance === 'system') return systemDark ? 'dark' : 'light'
  return appearance
}
