import type { IBuffer, IBufferCellPosition, ILink, ILinkProvider } from '@xterm/xterm'
import { findFilePaths, findUrls, type TextLink } from './terminalLinks'

/** The files path links may point at: the shown task's root and its files (relative POSIX paths). */
export interface LinkFiles {
  root: string
  files: ReadonlySet<string>
}

export interface TerminalLinkOptions {
  /** The terminal's active buffer, read whenever links are asked for. */
  buffer: () => IBuffer
  /** The shown task's files, or null while they are unknown (no path links then). */
  files: () => Promise<LinkFiles | null>
  /** Called when a link is clicked; the caller decides whether the click follows it (a modifier held). */
  activate: (event: MouseEvent, link: TextLink) => void
  hover?: (event: MouseEvent, link: TextLink) => void
  leave?: () => void
}

/**
 * One logical line of the buffer: the rows the terminal wrapped joined into one string, with the cell (1-based,
 * as link ranges want) where each string offset starts and how many cells it covers. Wide characters take two
 * cells and one or two string offsets; an empty cell reads as a space.
 */
interface LogicalLine {
  text: string
  cells: (IBufferCellPosition & { width: number })[]
}

function logicalLine(buffer: IBuffer, row: number): LogicalLine {
  let first = row
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  let last = row
  while (buffer.getLine(last + 1)?.isWrapped) last++
  let text = ''
  const cells: LogicalLine['cells'] = []
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue // the second half of a wide character
      const chars = cell.getChars() || ' '
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1, width: cell.getWidth() })
      text += chars
    }
  }
  return { text, cells }
}

/**
 * Turns http(s) URLs and paths to the task's files into links: underlined with a pointer on hover, followed on a
 * click the caller accepts. URLs and paths that the terminal wrapped onto the next row are found whole.
 */
export function createLinkProvider(opts: TerminalLinkOptions): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const { text, cells } = logicalLine(opts.buffer(), y - 1)
      const urls = findUrls(text)
      const toLink = (found: TextLink): ILink => {
        const start = cells[found.start]
        const end = cells[found.end - 1]
        return {
          range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } },
          text: text.slice(found.start, found.end),
          activate: (event) => opts.activate(event, found),
          hover: (event) => opts.hover?.(event, found),
          leave: () => opts.leave?.(),
        }
      }
      // Only the links on the asked row: a wrapped URL is offered once per row it covers, as xterm expects.
      const onRow = (link: ILink): boolean => link.range.start.y <= y && link.range.end.y >= y
      void opts
        .files()
        .catch(() => null)
        .then((files) => {
          const paths = files ? findFilePaths(text, files.root, files.files) : []
          const outsideUrls = paths.filter((p) => !urls.some((u) => p.start < u.end && u.start < p.end))
          const links = [...urls, ...outsideUrls].map(toLink).filter(onRow)
          callback(links.length > 0 ? links : undefined)
        })
    },
  }
}
