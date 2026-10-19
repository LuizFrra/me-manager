import { describe, expect, it } from 'vitest'
import { APPEARANCE_BACKGROUND } from '../../../shared/appearance'
import { TERMINAL_THEMES } from './terminalTheme'

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('TERMINAL_THEMES', () => {
  it('has the page background in each appearance', () => {
    expect(TERMINAL_THEMES.dark.background).toBe(APPEARANCE_BACKGROUND.dark)
    expect(TERMINAL_THEMES.light.background).toBe(APPEARANCE_BACKGROUND.light)
  })

  it('gives the light palette all 16 ANSI colours, each readable on its background (bright white aside)', () => {
    const light = TERMINAL_THEMES.light
    for (const name of ANSI) {
      const colour = light[name]
      expect(colour, name).toMatch(/^#[0-9a-f]{6}$/)
      if (name !== 'brightWhite') expect(contrast(colour!, light.background!), name).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(light.brightWhite!, light.background!)).toBeGreaterThanOrEqual(3)
    expect(contrast(light.foreground!, light.background!)).toBeGreaterThanOrEqual(7)
    expect(light.cursor).toBeDefined()
    expect(light.selectionBackground).toBeDefined()
  })

  it('gives the dark palette all 16 ANSI colours, each readable on the dark background (black aside)', () => {
    const dark = TERMINAL_THEMES.dark
    for (const name of ANSI) {
      const colour = dark[name]
      expect(colour, name).toMatch(/^#[0-9a-f]{6}$/)
      if (name !== 'black') expect(contrast(colour!, dark.background!), name).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(dark.foreground!, dark.background!)).toBeGreaterThanOrEqual(7)
    expect(dark.cursor).toBeDefined()
  })
})
