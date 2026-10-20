import { describe, expect, it, vi } from 'vitest'
import type { ClipboardSelectionType } from '@xterm/addon-clipboard'
import { createWriteOnlyClipboard } from './clipboardProvider'

const sel = (s: string): ClipboardSelectionType => s as ClipboardSelectionType
const setup = (): {
  write: ReturnType<typeof vi.fn>
  hold: ReturnType<typeof vi.fn>
  provider: ReturnType<typeof createWriteOnlyClipboard>
} => {
  const write = vi.fn(async () => {})
  const hold = vi.fn()
  return { write, hold, provider: createWriteOnlyClipboard({ write, hold }) }
}

describe('createWriteOnlyClipboard', () => {
  it('holds an empty selection (a tmux copy-mode copy, i.e. a mouse selection) instead of writing it', async () => {
    const { write, hold, provider } = setup()
    await provider.writeText(sel(''), 'hello')
    expect(hold).toHaveBeenCalledWith('hello')
    expect(write).not.toHaveBeenCalled()
  })

  it('writes for the system clipboard selection (a program copying on purpose)', async () => {
    const { write, hold, provider } = setup()
    await provider.writeText(sel('c'), 'hello')
    expect(write).toHaveBeenCalledWith('hello')
    expect(hold).not.toHaveBeenCalled()
  })

  it('writes when the selection list includes the system clipboard', async () => {
    const { write, provider } = setup()
    await provider.writeText(sel('pc'), 'hello')
    expect(write).toHaveBeenCalledWith('hello')
  })

  it('ignores the primary selection alone', async () => {
    const { write, hold, provider } = setup()
    await provider.writeText(sel('p'), 'hello')
    expect(write).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
  })

  it('never reads the clipboard', async () => {
    const { provider } = setup()
    expect(await provider.readText(sel(''))).toBe('')
    expect(await provider.readText(sel('c'))).toBe('')
    expect(await provider.readText(sel('p'))).toBe('')
  })
})
