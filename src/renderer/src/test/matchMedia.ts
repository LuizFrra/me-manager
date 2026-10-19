import { vi } from 'vitest'

/** A controllable window.matchMedia for '(prefers-color-scheme: dark)'; jsdom has none. Returns the switch. */
export function mockColorScheme(dark: boolean): { setDark(dark: boolean): void; listeners(): number } {
  let matches = dark
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = (query: string): MediaQueryList =>
    ({
      media: query,
      get matches() {
        return query === '(prefers-color-scheme: dark)' ? matches : false
      },
      addEventListener: (_type: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
      removeEventListener: (_type: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    }) as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(mql))
  return {
    setDark(next) {
      matches = next
      for (const l of [...listeners]) l({ matches: next } as MediaQueryListEvent)
    },
    listeners: () => listeners.size,
  }
}
