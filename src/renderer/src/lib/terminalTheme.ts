import type { ITheme } from '@xterm/xterm'
import { APPEARANCE_BACKGROUND } from '../../../shared/appearance'
import type { ResolvedAppearance } from '../../../shared/types'

/**
 * xterm's colours in each appearance, in Claude's palette: warm ANSI colours on the page background, a terracotta
 * cursor and a terracotta-tinted selection. Every ANSI colour reads on its background: in light, at least 4.5:1
 * (bright white 3:1), so "white" and "bright white" are warm greys; in dark, at least 4.5:1 except black.
 */
export const TERMINAL_THEMES: Readonly<Record<ResolvedAppearance, Readonly<ITheme>>> = {
  dark: {
    background: APPEARANCE_BACKGROUND.dark,
    foreground: '#e8e6dc',
    cursor: '#d97757',
    cursorAccent: '#262624',
    selectionBackground: '#d977574d',
    selectionInactiveBackground: '#d977572e',
    black: '#4a4943',
    red: '#f07360',
    green: '#8fbf7a',
    yellow: '#e8a04c',
    blue: '#86a8e0',
    magenta: '#c995dc',
    cyan: '#74bdb4',
    white: '#c2c0b6',
    brightBlack: '#8e8c84',
    brightRed: '#ff8f7d',
    brightGreen: '#a7d391',
    brightYellow: '#f2c06b',
    brightBlue: '#a6c1f0',
    brightMagenta: '#ddb1ec',
    brightCyan: '#94d6cd',
    brightWhite: '#faf9f5',
  },
  light: {
    background: APPEARANCE_BACKGROUND.light,
    foreground: '#29261b',
    cursor: '#bc5a3a',
    cursorAccent: '#faf9f5',
    selectionBackground: '#b4552e40',
    selectionInactiveBackground: '#b4552e24',
    black: '#29261b',
    red: '#b3261e',
    green: '#2f7a3a',
    yellow: '#7a5500',
    blue: '#2a5db0',
    magenta: '#8a3fa0',
    cyan: '#1f6f6a',
    white: '#6b6860',
    brightBlack: '#59554c',
    brightRed: '#8f1d17',
    brightGreen: '#256330',
    brightYellow: '#8a6100',
    brightBlue: '#1f4a8f',
    brightMagenta: '#6f2f84',
    brightCyan: '#185b57',
    brightWhite: '#8e8a80',
  },
}

/**
 * xterm's minimumContrastRatio in each appearance. Programs that pick their own (24-bit) colours mostly assume a
 * dark background, so in light mode xterm darkens any text that would read below AA on white. Dark keeps xterm's
 * default (no adjustment).
 */
export const TERMINAL_MIN_CONTRAST: Readonly<Record<ResolvedAppearance, number>> = { dark: 1, light: 4.5 }
