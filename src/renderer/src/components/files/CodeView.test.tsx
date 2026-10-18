import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { languageFor, MAX_HIGHLIGHT_BYTES } from '../../lib/highlight'
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
