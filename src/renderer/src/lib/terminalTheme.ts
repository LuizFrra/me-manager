import type { ITheme } from '@xterm/xterm'
import { APPEARANCE_BACKGROUND } from '../../../shared/appearance'
import type { ResolvedAppearance } from '../../../shared/types'

/**
 * xterm's colours in each appearance. Dark is xterm's own palette on the page background, as the app always had.
 * Light is a GitHub-light-like palette: every ANSI colour reads on white (at least 4.5:1, bright white 3:1), so
 * "white" and "bright white" are greys, and the selection is a translucent blue.
 */
export const TERMINAL_THEMES: Readonly<Record<ResolvedAppearance, Readonly<ITheme>>> = {
  dark: { background: APPEARANCE_BACKGROUND.dark },
  light: {
    background: APPEARANCE_BACKGROUND.light,
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#ffffff',
    selectionBackground: '#0969da40',
    selectionInactiveBackground: '#0969da24',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#9a6700',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#136061',
    brightWhite: '#8c959f',
  },
}

/**
 * xterm's minimumContrastRatio in each appearance. Programs that pick their own (24-bit) colours mostly assume a
 * dark background, so in light mode xterm darkens any text that would read below AA on white. Dark keeps xterm's
 * default (no adjustment).
 */
export const TERMINAL_MIN_CONTRAST: Readonly<Record<ResolvedAppearance, number>> = { dark: 1, light: 4.5 }
