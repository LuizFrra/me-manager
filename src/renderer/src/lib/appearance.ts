import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import { resolveAppearance } from '../../../shared/appearance'
import type { Appearance, ResolvedAppearance } from '../../../shared/types'

const DARK_QUERY = '(prefers-color-scheme: dark)'

// Without matchMedia (jsdom) there is no preference: dark, the app's original look.
const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null

function subscribe(onChange: () => void): () => void {
  const query = darkQuery()
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

const systemDark = (): boolean => darkQuery()?.matches ?? true

/**
 * What the UI is drawn in, for components that can't use CSS alone (the terminal, Mermaid). Provided by App;
 * dark outside it.
 */
export const AppearanceContext = createContext<ResolvedAppearance>('dark')

export const useResolvedAppearance = (): ResolvedAppearance => useContext(AppearanceContext)

/**
 * Resolves `appearance` (following the OS preference live when it is 'system') and puts the result on the root
 * element as data-appearance, which picks the CSS colours. In Electron prefers-color-scheme follows
 * nativeTheme.themeSource, which main sets from the same setting, so the media query already agrees with an
 * explicit setting too.
 */
export function useDocumentAppearance(appearance: Appearance): ResolvedAppearance {
  const dark = useSyncExternalStore(subscribe, systemDark)
  const resolved = resolveAppearance(appearance, dark)
  useLayoutEffect(() => {
    document.documentElement.dataset.appearance = resolved
  }, [resolved])
  return resolved
}
