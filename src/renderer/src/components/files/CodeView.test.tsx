import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { languageFor, MAX_HIGHLIGHT_BYTES } from '../../lib/highlight'
import type { LineSelection } from '../../lib/lineSelection'
import { selectedLinesLabel, type SelectedLines } from '../../lib/review'
import { CodeView } from './CodeView'

describe('languageFor', () => {
  it('maps extensions and well-known names to highlight.js languages', () => {
    expect(languageFor('src/App.tsx')).toBe('tsx')
    expect(languageFor('a/b/main.py')).toBe('py')
    expect(languageFor('lib/x.mjs')).toBe('javascript')
    expect(languageFor('Makefile')).toBe('makefile')
    expect(languageFor('notes.txt')).toBe('plaintext')
    expect(languageFor('LICENSE')).toBeUndefined()
    expect(languageFor('file.unknownext')).toBeUndefined()
  })
})

describe('CodeView', () => {
  it('highlights known languages and numbers the lines', () => {
    const { container } = render(<CodeView path="a.ts" content={'const x = 1\nexport default x\n'} />)
    expect(container.querySelector('.code-body .hljs-keyword')).toHaveTextContent('const')
    expect(container.querySelector('.code-gutter')?.textContent).toBe('1\n2')
  })

  it('escapes markup in the source', () => {
    const { container } = render(
      <CodeView path="page.html" content={'<script>alert(1)</script><img src=x onerror=alert(1)>'} />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.code-body')?.textContent).toContain('<script>alert(1)</script>')
  })

  it('shows plain text for big and plain files', () => {
    const big = 'let a = 1\n'.repeat(MAX_HIGHLIGHT_BYTES / 10 + 1)
    const { container } = render(<CodeView path="big.ts" content={big} />)
    expect(container.querySelector('.code-body span')).toBeNull()
    const plain = render(<CodeView path="notes.txt" content="if (x) return" />)
    expect(plain.container.querySelector('.code-body span')).toBeNull()
  })
})

describe('CodeView highlightLine', () => {
  it('marks the line and scrolls it into view, again only when the line or file changes', () => {
    const scroll = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      const content = 'a\nb\nc\nd\n'
      const { container, rerender } = render(<CodeView path="a.txt" content={content} highlightLine={3} />)
      const mark = container.querySelector('.code-line-mark') as HTMLElement
      expect(mark).toHaveAttribute('data-line', '3')
      expect(mark.style.getPropertyValue('--mark-line')).toBe('2')
      expect(scroll).toHaveBeenCalledTimes(1)
      rerender(<CodeView path="a.txt" content={`${content}e\n`} highlightLine={3} />)
      expect(scroll).toHaveBeenCalledTimes(1)
      rerender(<CodeView path="a.txt" content={content} highlightLine={4} />)
      expect(scroll).toHaveBeenCalledTimes(2)
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('marks nothing without a line, or for a line past the end', () => {
    const { container, rerender } = render(<CodeView path="a.txt" content={'a\nb\n'} />)
    expect(container.querySelector('.code-line-mark')).toBeNull()
    rerender(<CodeView path="a.txt" content={'a\nb\n'} highlightLine={9} />)
    expect(container.querySelector('.code-line-mark')).toBeNull()
  })
})

/** A CodeView whose line selection is kept here; the selected lines show in an <output>. */
function Selectable(props: { content: string; onComment?: () => void }): React.JSX.Element {
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [lines, setLines] = useState<SelectedLines | null>(null)
  return (
    <>
      <CodeView
        path="a.txt"
        content={props.content}
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

/** Where line `n` is in the gutter: the 8px padding, then 18px per line (jsdom has no layout: top is 0). */
const lineY = (n: number): number => 8 + (n - 1) * 18 + 5

describe('CodeView line selection', () => {
  it('selects the clicked line number, Shift-click extends, and marks the selection', () => {
    const { container } = render(<Selectable content={'a\nb\nc\nd\ne\n'} />)
    const gutter = screen.getByRole('group', { name: 'Line numbers' })
    fireEvent.click(gutter, { clientY: lineY(2) })
    expect(screen.getByRole('status')).toHaveTextContent('Line 2')
    fireEvent.click(gutter, { clientY: lineY(4), shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Lines 2–4')
    const mark = container.querySelector('.code-line-sel') as HTMLElement
    expect(mark.style.getPropertyValue('--sel-line')).toBe('1')
    expect(mark.style.getPropertyValue('--sel-lines')).toBe('3')
    // Below the last line: the last line.
    fireEvent.click(gutter, { clientY: lineY(40) })
    expect(screen.getByRole('status')).toHaveTextContent('Line 5')
    fireEvent.click(gutter, { clientY: lineY(5) })
    expect(screen.getByRole('status')).toHaveTextContent('none')
    expect(container.querySelector('.code-line-sel')).toBeNull()
  })

  it('selects with the keyboard and comments with C', async () => {
    const user = userEvent.setup()
    const onComment = vi.fn()
    render(<Selectable content={'a\nb\nc\n'} onComment={onComment} />)
    screen.getByRole('group', { name: 'Line numbers' }).focus()
    await user.keyboard('{ArrowDown}{Shift>}{ArrowDown}{/Shift}')
    expect(screen.getByRole('status')).toHaveTextContent('Lines 1–2')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('status')).toHaveTextContent('Line 1')
    await user.keyboard('c')
    expect(onComment).toHaveBeenCalledTimes(1)
  })

  it('has no focusable line numbers without the select prop', () => {
    render(<CodeView path="a.txt" content={'a\n'} />)
    expect(screen.queryByRole('group', { name: 'Line numbers' })).toBeNull()
  })
})
