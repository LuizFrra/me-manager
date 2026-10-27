import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DiffLayout } from '../../lib/diff/layout'
import type { LineSelection } from '../../lib/lineSelection'
import { selectedLinesLabel, type SelectedLines } from '../../lib/review'
import { DIFF_ROW_HEIGHT, DiffView } from './DiffView'
import {
  ADDED_FILE,
  BINARY,
  BINARY_ADDED,
  BINARY_DELETED,
  EMPTY_ADDED,
  EMPTY_DELETED,
  FILE_TO_SYMLINK,
  LF_TO_CRLF,
  MODE_AND_CONTENT,
  MODE_ONLY,
  MULTI_HUNK,
  NO_NEWLINE,
  RENAME_ONLY,
  SINGLE_HUNK,
  UNTRACKED_NO_INDEX,
} from '../../lib/diff/fixtures'

function largeDiff(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+added ${i + 1}`).join('\n')
  return `diff --git a/big.txt b/big.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/big.txt
@@ -0,0 +1,${lines} @@
${body}
`
}

describe('DiffView', () => {
  it('renders an added line with class diff-add and its line number', () => {
    render(<DiffView diff={SINGLE_HUNK} />)
    const row = screen.getByText('BETA').closest('tr')
    expect(row).toHaveClass('diff-add')
    const cells = row!.querySelectorAll('td')
    expect(cells[0]).toHaveTextContent('')
    expect(cells[1]).toHaveTextContent('2')
  })

  it('renders deletions, context and hunk headers with their classes', () => {
    render(<DiffView diff={SINGLE_HUNK} />)
    const del = screen.getByText('beta').closest('tr')!
    expect(del).toHaveClass('diff-del')
    expect(del.querySelectorAll('td')[0]).toHaveTextContent('2')
    expect(screen.getByText('alpha').closest('tr')).toHaveClass('diff-context')
    expect(screen.getByText('@@ -1,3 +1,3 @@').closest('tr')).toHaveClass('diff-hunk')
  })

  it('renders "no newline" notes with class diff-note', () => {
    render(<DiffView diff={NO_NEWLINE} />)
    const notes = screen.getAllByText('\\ No newline at end of file')
    expect(notes).toHaveLength(2)
    for (const n of notes) expect(n.closest('tr')).toHaveClass('diff-note')
  })

  it('shows "No changes." for empty input', () => {
    render(<DiffView diff="" />)
    expect(screen.getByText('No changes.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows a notice for binary files', () => {
    render(<DiffView diff={BINARY} />)
    expect(screen.getByText('Binary file changed.')).toBeInTheDocument()
  })

  it('says a binary file was added or deleted', () => {
    const { unmount } = render(<DiffView diff={BINARY_ADDED} />)
    expect(screen.getByText('Binary file added.')).toBeInTheDocument()
    unmount()
    render(<DiffView diff={BINARY_DELETED} />)
    expect(screen.getByText('Binary file deleted.')).toBeInTheDocument()
  })

  it('says an empty file was added or deleted instead of "No changes."', () => {
    const { unmount } = render(<DiffView diff={EMPTY_ADDED} />)
    expect(screen.getByText('Empty file added.')).toBeInTheDocument()
    expect(screen.queryByText('No changes.')).not.toBeInTheDocument()
    unmount()
    render(<DiffView diff={EMPTY_DELETED} />)
    expect(screen.getByText('Empty file deleted.')).toBeInTheDocument()
  })

  it('shows a change of the file mode alone, or above the lines', () => {
    const { unmount } = render(<DiffView diff={MODE_ONLY} />)
    expect(screen.getByText('Made executable (mode 100644 → 100755)')).toBeInTheDocument()
    expect(screen.queryByText('No changes.')).not.toBeInTheDocument()
    unmount()
    const { unmount: unmount2 } = render(<DiffView diff={MODE_AND_CONTENT} />)
    expect(screen.getByText('Made executable (mode 100644 → 100755)')).toBeInTheDocument()
    expect(screen.getByText('B').closest('tr')).toHaveClass('diff-add')
    unmount2()
    render(<DiffView diff={FILE_TO_SYMLINK} layout="split" />)
    expect(screen.getByText('Changed from a regular file to a symlink (mode 100644 → 120000)')).toBeInTheDocument()
  })

  it('marks CRLF line endings when the diff mixes them with LF ones', () => {
    const { container, unmount } = render(<DiffView diff={LF_TO_CRLF} />)
    expect(screen.getByText('Line endings differ: ␍ marks the lines that end in CRLF.')).toBeInTheDocument()
    const marked = [...container.querySelectorAll('.diff-eol')].map((m) => m.closest('tr')?.className)
    expect(marked).toEqual(['diff-context', 'diff-add', 'diff-add'])
    unmount()
    const split = render(<DiffView diff={LF_TO_CRLF} layout="split" />)
    // The unchanged line on both sides, and the two added lines.
    expect(split.container.querySelectorAll('.diff-eol')).toHaveLength(4)
    split.unmount()
    // A file with CRLF endings throughout: nothing to tell apart.
    const crlf = render(<DiffView diff={SINGLE_HUNK.replace(/^([ +-][^+-].*)$/gm, '$1\r')} />)
    expect(crlf.container.querySelector('.diff-eol')).toBeNull()
    expect(screen.queryByText(/Line endings differ/)).not.toBeInTheDocument()
    expect(screen.getByText('BETA')).toBeInTheDocument()
  })

  it('shows the old path for a pure rename', () => {
    render(<DiffView diff={RENAME_ONLY} />)
    expect(screen.getByText('Renamed from old-name.txt')).toBeInTheDocument()
  })

  it('hides a large diff behind a button and renders it on click', async () => {
    const user = userEvent.setup()
    render(<DiffView diff={largeDiff(50_001)} />)
    expect(screen.getByText('Large diff (50001 lines)')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    // Its first rows: the others render as they are scrolled to.
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '50002')
    expect(screen.getByText('added 1').closest('tr')).toHaveClass('diff-add')
  })

  it('renders a 50,000-line diff directly', () => {
    render(<DiffView diff={largeDiff(50_000)} />)
    expect(screen.queryByRole('button', { name: 'Show diff anyway' })).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('collapses again when a different large diff arrives', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DiffView diff={largeDiff(50_001)} />)
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    rerender(<DiffView diff={largeDiff(60_000)} />)
    expect(screen.getByText('Large diff (60000 lines)')).toBeInTheDocument()
  })

  it('renders <script> in diff text as plain text', () => {
    const { container } = render(<DiffView diff={UNTRACKED_NO_INDEX} />)
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})

describe('DiffView marked lines', () => {
  it("marks a comment's lines, new ones by their new number and removed ones by their old one, and scrolls to them", () => {
    const scroll = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      const mark = { lines: { start: 27, end: 28 }, removed: { start: 27, end: 27 } }
      const { rerender } = render(<DiffView diff={MULTI_HUNK} mark={mark} />)
      const marked = (): string[] =>
        [...document.querySelectorAll('.diff-marked')].map((el) => el.querySelector('.diff-text')?.textContent ?? '')
      expect(marked()).toEqual(['line 27', 'line twenty-seven', 'line 28'])
      expect(scroll).toHaveBeenCalledTimes(1)
      expect(scroll.mock.contexts[0]).toHaveTextContent('line 27')
      // Not again for the same request (a poll, another layout), but for a new one.
      rerender(<DiffView diff={`${MULTI_HUNK}`} mark={mark} layout="split" />)
      expect(scroll).toHaveBeenCalledTimes(1)
      expect([...document.querySelectorAll('td.diff-text.diff-marked')].map((td) => td.textContent)).toEqual([
        'line 27',
        'line twenty-seven',
        'line 28',
        'line 28',
      ])
      rerender(<DiffView diff={MULTI_HUNK} mark={{ ...mark }} layout="split" />)
      expect(scroll).toHaveBeenCalledTimes(2)
      // Lines the diff doesn't show: nothing to mark or scroll to.
      rerender(<DiffView diff={MULTI_HUNK} mark={{ lines: { start: 12, end: 14 } }} />)
      expect(document.querySelector('.diff-marked')).toBeNull()
      expect(scroll).toHaveBeenCalledTimes(2)
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })
})

describe('DiffView split layout', () => {
  /** A row's cells as text, `·` for an empty one. */
  const cells = (row: Element): string[] => [...row.querySelectorAll('td')].map((td) => td.textContent || '·')

  it('shows old on the left and new on the right, with line numbers on both sides', () => {
    render(<DiffView diff={SINGLE_HUNK} layout="split" />)
    const table = screen.getByRole('table', { name: 'Side-by-side diff' })
    const rows = [...table.querySelectorAll('tr')]
    expect(rows.map(cells)).toEqual([
      ['@@ -1,3 +1,3 @@'],
      ['1', 'alpha', '1', 'alpha'],
      ['2', 'beta', '2', 'BETA'],
      ['3', 'gamma', '3', 'gamma'],
    ])
    expect(screen.getByText('beta')).toHaveClass('diff-text', 'diff-del')
    expect(screen.getByText('BETA')).toHaveClass('diff-text', 'diff-add')
    expect(screen.getAllByText('alpha').map((td) => td.className)).toEqual([
      'diff-text diff-context',
      'diff-text diff-context',
    ])
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toHaveAttribute('colspan', '4')
  })

  it('pads the side without a line with empty cells', () => {
    const { container } = render(<DiffView diff={ADDED_FILE} layout="split" />)
    const row = screen.getByText('brand new').closest('tr')!
    expect(cells(row)).toEqual(['·', '·', '1', 'brand new'])
    expect(row.querySelectorAll('td.diff-empty')).toHaveLength(2)
    expect(container.querySelector('.diff-view')).toHaveClass('diff-view-split')
  })

  it('puts the no-newline notes on their sides', () => {
    render(<DiffView diff={NO_NEWLINE} layout="split" />)
    const notes = screen.getAllByText('\\ No newline at end of file')
    expect(notes).toHaveLength(2)
    for (const n of notes) expect(n).toHaveClass('diff-note')
    expect(cells(notes[0].closest('tr')!)).toEqual([
      '·',
      '\\ No newline at end of file',
      '·',
      '\\ No newline at end of file',
    ])
  })

  it('renders every hunk with its header', () => {
    render(<DiffView diff={MULTI_HUNK} layout="split" />)
    expect(screen.getByText('@@ -24,7 +24,7 @@ line 23')).toBeInTheDocument()
    expect(cells(screen.getByText('line twenty-seven').closest('tr')!)).toEqual([
      '27',
      'line 27',
      '27',
      'line twenty-seven',
    ])
  })

  it('collapses a large diff the same way, then renders it split', async () => {
    const user = userEvent.setup()
    render(<DiffView diff={largeDiff(50_001)} layout="split" />)
    expect(screen.getByText('Large diff (50001 lines)')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    expect(screen.getByRole('table', { name: 'Side-by-side diff' })).toHaveAttribute('aria-rowcount', '50002')
    expect(screen.getByText('added 1')).toHaveClass('diff-add')
  })

  it('switches layouts without losing the expanded state of a large diff', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DiffView diff={largeDiff(50_001)} />)
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    rerender(<DiffView diff={largeDiff(50_001)} layout="split" />)
    expect(screen.getByRole('table', { name: 'Side-by-side diff' })).toBeInTheDocument()
  })

  it('renders <script> in diff text as plain text', () => {
    const { container } = render(<DiffView diff={UNTRACKED_NO_INDEX} layout="split" />)
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})

/** A DiffView whose line selection is kept here; the selected lines show in an <output>. */
function Selectable(props: { diff: string; layout?: DiffLayout; onComment?: () => void }): React.JSX.Element {
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [lines, setLines] = useState<SelectedLines | null>(null)
  return (
    <>
      <DiffView
        diff={props.diff}
        layout={props.layout}
        select={{
          selection,
          onSelect: (next, covered) => {
            setSelection(next)
            setLines(covered)
          },
          onComment: props.onComment ?? (() => {}),
        }}
      />
      <output>{lines ? selectedLinesLabel(lines) : 'none'}</output>
    </>
  )
}

/** The line-number cells of the row showing `text`. */
const numbersOf = (text: string): HTMLElement[] => [
  ...screen.getByText(text).closest('tr')!.querySelectorAll<HTMLElement>('td.diff-ln, td:nth-child(-n + 2)'),
]

describe('DiffView line selection', () => {
  it('selects a line by its number, Shift-click extends, with deleted lines by their old number', () => {
    render(<Selectable diff={SINGLE_HUNK} />)
    fireEvent.click(numbersOf('BETA')[1])
    expect(screen.getByRole('status')).toHaveTextContent('Line 2')
    expect(screen.getByText('BETA').closest('tr')).toHaveClass('diff-selected')
    fireEvent.click(numbersOf('gamma')[0], { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Lines 2–3')
    fireEvent.click(numbersOf('alpha')[1], { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Lines 1–2 and removed line 2')
    expect(screen.getByText('beta').closest('tr')).toHaveClass('diff-selected')
    expect(screen.getByText('gamma').closest('tr')).not.toHaveClass('diff-selected')
    // The only selected line, clicked again, is unselected; text cells select nothing.
    fireEvent.click(numbersOf('alpha')[0])
    fireEvent.click(numbersOf('alpha')[0])
    expect(screen.getByRole('status')).toHaveTextContent('none')
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByRole('status')).toHaveTextContent('none')
  })

  it('selects with the keyboard and comments with C', async () => {
    const user = userEvent.setup()
    const onComment = vi.fn()
    render(<Selectable diff={MULTI_HUNK} onComment={onComment} />)
    const table = screen.getByRole('table', { name: 'Diff' })
    table.focus()
    await user.keyboard('c')
    expect(onComment).not.toHaveBeenCalled() // nothing selected yet
    await user.keyboard('{ArrowDown}{ArrowDown}{Shift>}{ArrowDown}{ArrowDown}{/Shift}')
    expect(screen.getByRole('status')).toHaveTextContent('Lines 2–3 and removed line 3')
    await user.keyboard('c')
    expect(onComment).toHaveBeenCalledTimes(1)
    // Across hunks: the last line of the first one and the first of the second.
    await user.keyboard('{End}')
    expect(screen.getByRole('status')).toHaveTextContent('Line 30')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('status')).toHaveTextContent('none')
  })

  it('selects either side of the split layout, both for unchanged lines', () => {
    render(<Selectable diff={SINGLE_HUNK} layout="split" />)
    const row = screen.getByText('beta').closest('tr')!
    const [oldNo, , newNo] = row.querySelectorAll<HTMLElement>('td')
    fireEvent.click(oldNo)
    expect(screen.getByRole('status')).toHaveTextContent('Removed line 2')
    expect(screen.getByText('beta')).toHaveClass('diff-selected')
    expect(screen.getByText('BETA')).not.toHaveClass('diff-selected')
    fireEvent.click(newNo, { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Line 2 and removed line 2')
    fireEvent.click(screen.getAllByText('gamma')[0].closest('tr')!.querySelector('td')!)
    expect(screen.getByRole('status')).toHaveTextContent('Line 3')
    for (const cell of screen.getAllByText('gamma')) expect(cell).toHaveClass('diff-selected')
  })

  it('offers no selection without the select prop', () => {
    render(<DiffView diff={SINGLE_HUNK} />)
    expect(screen.getByRole('table')).not.toHaveAttribute('tabindex')
    expect(document.querySelector('[data-sel]')).toBeNull()
  })
})

/**
 * Renders `ui` in a scroller 10 rows high. jsdom has no layout: the scroller gets its height, and the table's body a
 * position that follows its scrollTop (call `layOut` again when the table is replaced).
 */
function renderScrolled(ui: React.ReactElement): {
  scroller: HTMLElement
  layOut: () => void
  rerender: (ui: React.ReactElement) => void
} {
  const inScroller = (child: React.ReactElement): React.JSX.Element => (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      {child}
    </div>
  )
  const { rerender } = render(inScroller(ui))
  const scroller = screen.getByTestId('scroller')
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 10 * DIFF_ROW_HEIGHT })
  const layOut = (): void => {
    scroller.querySelector('tbody')!.getBoundingClientRect = () => ({ top: -scroller.scrollTop }) as DOMRect
  }
  layOut()
  return { scroller, layOut, rerender: (next) => rerender(inScroller(next)) }
}

const scrollTo = (scroller: HTMLElement, top: number): void => {
  scroller.scrollTop = top
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
}

/** The table's rows in the DOM, spacers left out. */
const shownRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('tbody tr:not(.diff-spacer)')]

describe('DiffView virtualization', () => {
  // The hunk header is row 0, so line n is row n.
  const rowTop = (n: number): number => n * DIFF_ROW_HEIGHT

  it.each(['unified', 'split'] as const)('renders only the rows in view of a 50,000-line diff (%s)', (layout) => {
    const { scroller } = renderScrolled(<DiffView diff={largeDiff(50_000)} layout={layout} />)
    const table = screen.getByRole('table')
    expect(table).toHaveAttribute('aria-rowcount', '50001')
    expect(shownRows().length).toBeLessThan(60)
    expect(shownRows()[0]).toHaveAttribute('aria-rowindex', '1')
    expect(screen.getByText('@@ -0,0 +1,50000 @@')).toBeInTheDocument()

    scrollTo(scroller, rowTop(30_000))
    expect(screen.queryByText('added 1')).toBeNull()
    expect(screen.getByText('added 30000').closest('tr')).toHaveAttribute('aria-rowindex', '30001')
    expect(screen.getByText('added 30009')).toBeInTheDocument()
    expect(shownRows().length).toBeLessThan(40)
    // The spacers stand for the rows left out, so the table keeps its height.
    const [above, below] = document.querySelectorAll<HTMLElement>('tr.diff-spacer')
    const first = Number(shownRows()[0].getAttribute('aria-rowindex')) - 1
    expect(above.style.height).toBe(`${first * DIFF_ROW_HEIGHT}px`)
    expect(parseFloat(above.style.height) + shownRows().length * DIFF_ROW_HEIGHT + parseFloat(below.style.height)).toBe(
      50_001 * DIFF_ROW_HEIGHT,
    )
  })

  it('keeps a selection wider than the rows rendered, and Shift-click after scrolling extends it', () => {
    const { scroller } = renderScrolled(<Selectable diff={largeDiff(50_000)} />)
    fireEvent.click(numbersOf('added 2')[1])
    scrollTo(scroller, rowTop(40_000))
    fireEvent.click(numbersOf('added 40005')[1], { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Lines 2–40005')
    expect(screen.getByText('added 40000').closest('tr')).toHaveClass('diff-selected')
    expect(screen.getByText('added 40006').closest('tr')).not.toHaveClass('diff-selected')
    scrollTo(scroller, rowTop(20_000))
    expect(screen.getByText('added 20000').closest('tr')).toHaveClass('diff-selected')
    scrollTo(scroller, 0)
    expect(screen.getByText('added 1').closest('tr')).not.toHaveClass('diff-selected')
    expect(screen.getByText('added 2').closest('tr')).toHaveClass('diff-selected')
  })

  it('scrolls the line the keys move to into view, rendering it', async () => {
    const user = userEvent.setup()
    const { scroller } = renderScrolled(<Selectable diff={largeDiff(50_000)} />)
    screen.getByRole('table', { name: 'Diff' }).focus()
    await user.keyboard('{End}')
    expect(screen.getByRole('status')).toHaveTextContent('Line 50000')
    expect(screen.getByText('added 50000').closest('tr')).toHaveClass('diff-selected')
    expect(scroller.scrollTop).toBe(rowTop(50_001) - 10 * DIFF_ROW_HEIGHT)
    await user.keyboard('{Shift>}{Home}{/Shift}')
    expect(screen.getByRole('status')).toHaveTextContent('Lines 1–50000')
    expect(screen.getByText('added 1').closest('tr')).toHaveClass('diff-selected')
    expect(scroller.scrollTop).toBe(rowTop(1))
  })

  it('selects either side of the split layout after scrolling', () => {
    const { scroller } = renderScrolled(<Selectable diff={largeDiff(50_000)} layout="split" />)
    scrollTo(scroller, rowTop(25_000))
    const newNo = (text: string): HTMLElement => screen.getByText(text).closest('tr')!.querySelectorAll('td')[2]
    fireEvent.click(newNo('added 25001'))
    fireEvent.click(newNo('added 25003'), { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Lines 25001–25003')
    expect(screen.getByText('added 25002')).toHaveClass('diff-selected')
  })

  it('scrolls to marked lines far down a long diff, rendering them', () => {
    const scroll = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      const diff = largeDiff(50_000)
      const { scroller, rerender } = renderScrolled(<DiffView diff={diff} />)
      rerender(<DiffView diff={diff} mark={{ lines: { start: 30_000, end: 30_000 } }} />)
      expect(scroller.scrollTop).toBeGreaterThan(rowTop(29_900))
      expect(screen.getByText('added 30000').closest('tr')).toHaveClass('diff-marked')
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent('added 30000')
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('renders every row of a small diff, without row counts', () => {
    renderScrolled(<DiffView diff={MULTI_HUNK} />)
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-rowcount')
    expect(document.querySelector('tr.diff-spacer')).toBeNull()
  })
})
