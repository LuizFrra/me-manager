import { describe, expect, it } from 'vitest'
import { charWidth, stringWidth } from './unicodeWidths'

describe('charWidth', () => {
  it('counts like the system wcwidth', () => {
    expect(charWidth(0x41)).toBe(1) // A
    expect(charWidth(0x4e2d)).toBe(2) // 中
    expect(charWidth(0x2705)).toBe(2) // ✅ (Unicode 6 said 1)
    expect(charWidth(0x1f680)).toBe(2) // 🚀 (Unicode 6 said 1)
    expect(charWidth(0x23fa)).toBe(1) // ⏺, Claude Code's bullet
    expect(charWidth(0x0301)).toBe(0) // combining acute
    expect(charWidth(0x07)).toBe(0) // BEL
    expect(charWidth(0x20000)).toBe(2) // CJK extension B
  })
})

describe('stringWidth', () => {
  // Each measured in tmux 3.5a: the cursor column after printing the text.
  const measuredInTmux: [string, number][] = [
    ['✅X🚀Y', 6],
    ['👍🏽', 2],
    ['👨‍👩‍👧', 2],
    ['🇧🇷', 2],
    ['❤️', 2],
    ['⚠️', 2],
    ['☺️', 2],
    ['#️⃣', 2],
    ['é', 1],
    ['é', 1],
    ['⏺ Done', 6],
    ['中文', 4],
  ]
  it.each(measuredInTmux)('%s takes as many cells as in tmux', (text, cells) => {
    expect(stringWidth(text)).toBe(cells)
  })
})
