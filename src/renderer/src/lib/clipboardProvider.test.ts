import { describe, expect, it, vi } from 'vitest'
import type { ClipboardSelectionType } from '@xterm/addon-clipboard'
import { createWriteOnlyClipboard } from './clipboardProvider'

const sel = (s: string): ClipboardSelectionType => s as ClipboardSelectionType

describe('createWriteOnlyClipboard', () => {
  it('writes when the selection is empty (what tmux sends)', async () => {
    const writeText = vi.fn(async () => {})
    await createWriteOnlyClipboard(writeText).writeText(sel(''), 'hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('writes for the system clipboard selection', async () => {
    const writeText = vi.fn(async () => {})
    await createWriteOnlyClipboard(writeText).writeText(sel('c'), 'hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('writes when the selection list includes the system clipboard', async () => {
    const writeText = vi.fn(async () => {})
    await createWriteOnlyClipboard(writeText).writeText(sel('pc'), 'hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('ignores the primary selection alone', async () => {
    const writeText = vi.fn(async () => {})
    await createWriteOnlyClipboard(writeText).writeText(sel('p'), 'hello')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('never reads the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    const provider = createWriteOnlyClipboard(writeText)
    expect(await provider.readText(sel(''))).toBe('')
    expect(await provider.readText(sel('c'))).toBe('')
    expect(await provider.readText(sel('p'))).toBe('')
  })
})
