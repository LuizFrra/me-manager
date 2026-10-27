import type { IBuffer, IBufferCell, IBufferLine, ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createLinkProvider, type LinkFiles } from './terminalLinkProvider'
import type { TextLink } from './terminalLinks'

/** A buffer of `cols`-wide rows; a row starting with '>' continues the previous one (the terminal wrapped it). */
function fakeBuffer(rows: string[], cols: number): IBuffer {
  const lines: IBufferLine[] = rows.map((row) => {
    const wrapped = row.startsWith('>')
    const chars = [...(wrapped ? row.slice(1) : row)]
    // A wide character (here: one from the CJK block) takes its cell and a zero-width one after it.
    const cells: { chars: string; width: number }[] = []
    for (const c of chars) {
      const wide = /[一-鿿]/.test(c)
      cells.push({ chars: c, width: wide ? 2 : 1 })
      if (wide) cells.push({ chars: '', width: 0 })
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 })
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x: number) =>
        cells[x] && ({ getChars: () => cells[x].chars, getWidth: () => cells[x].width } as unknown as IBufferCell),
    } as unknown as IBufferLine
  })
  return { getLine: (y: number) => lines[y] } as unknown as IBuffer
}

function linksAt(buffer: IBuffer, y: number, files: LinkFiles | null = null): Promise<ILink[]> {
  const provider = createLinkProvider({ buffer: () => buffer, files: async () => files, activate: vi.fn() })
  return new Promise((resolve) => provider.provideLinks(y, (links) => resolve(links ?? [])))
}

describe('createLinkProvider', () => {
  it('gives a URL its 1-based cell range', async () => {
    const [link] = await linksAt(fakeBuffer(['go https://a.dev/x now'], 30), 1)
    expect(link.text).toBe('https://a.dev/x')
    expect(link.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 18, y: 1 } })
  })

  it('finds a URL the terminal wrapped onto the next row, from either row', async () => {
    const buffer = fakeBuffer(['see https://', '>a.dev/long', 'next'], 12)
    for (const y of [1, 2]) {
      const [link] = await linksAt(buffer, y)
      expect(link.text).toBe('https://a.dev/long')
      expect(link.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 10, y: 2 } })
    }
    expect(await linksAt(buffer, 3)).toEqual([])
  })

  it('counts wide characters as two cells', async () => {
    const [link] = await linksAt(fakeBuffer(['中文 https://a.dev'], 30), 1)
    expect(link.range.start.x).toBe(6)
  })

  it('links paths to the task files, and passes the found link to activate', async () => {
    const activate = vi.fn<(e: MouseEvent, link: TextLink) => void>()
    const provider = createLinkProvider({
      buffer: () => fakeBuffer(['Edit(src/a.ts:3) and src/b.ts'], 40),
      files: async () => ({ root: '/r', files: new Set(['src/a.ts']) }),
      activate,
    })
    const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(1, (l) => resolve(l ?? [])))
    expect(links.map((l) => l.text)).toEqual(['src/a.ts:3'])
    const event = new MouseEvent('mouseup')
    links[0].activate(event, links[0].text)
    expect(activate).toHaveBeenCalledWith(event, expect.objectContaining({ kind: 'file', path: 'src/a.ts', line: 3 }))
  })

  it('still offers URLs when the files cannot be listed', async () => {
    const provider = createLinkProvider({
      buffer: () => fakeBuffer(['https://a.dev'], 20),
      files: () => Promise.reject(new Error('gone')),
      activate: vi.fn(),
    })
    const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(1, (l) => resolve(l ?? [])))
    expect(links.map((l) => l.text)).toEqual(['https://a.dev'])
  })
})
