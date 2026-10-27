import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>', diagramType: 'flowchart' })),
}))
vi.mock('mermaid', () => ({ default: mermaidMock }))

import { MarkdownView, type MarkdownViewProps } from './MarkdownView'

function setup(
  source: string,
  overrides: Partial<MarkdownViewProps> = {},
): ReturnType<typeof render> & { props: MarkdownViewProps } {
  const props: MarkdownViewProps = {
    source,
    filePath: 'docs/a.md',
    loadImage: vi.fn(async () => 'data:image/png;base64,AAAA'),
    onOpenLink: vi.fn(),
    onOpenExternal: vi.fn(),
    ...overrides,
  }
  const utils = render(<MarkdownView {...props} />)
  return { ...utils, props }
}

function click(el: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(el, event)
  return event
}

describe('MarkdownView', () => {
  it('wraps the output in .markdown-body', () => {
    const { container } = setup('# Title')
    expect(container.querySelector('.markdown-body h1')).toHaveTextContent('Title')
  })

  it('renders a GFM table', () => {
    const { container } = setup('| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('highlights a fenced ts block', () => {
    const { container } = setup('```ts\nconst x: number = 1\n```\n')
    const code = container.querySelector('pre code')
    expect(code).toHaveClass('hljs')
    expect(code!.querySelector('[class^="hljs-"]')).not.toBeNull()
  })

  it('renders a mermaid fence with MermaidBlock instead of a code block', async () => {
    const { container } = setup('before\n\n```mermaid\ngraph TD; A-->B\n```\n\nafter')
    expect(await screen.findByTestId('mermaid-svg')).toBeInTheDocument()
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.any(String), 'graph TD; A-->B')
    expect(container.querySelector('code.language-mermaid')).toBeNull()
    expect(screen.getByText('after')).toBeInTheDocument()
  })

  it('keeps images and diagrams mounted when rerendered with new callbacks but the same source', async () => {
    const source = '![logo](img/logo.png)\n\n```mermaid\ngraph TD; A-->B\n```\n'
    const { container, props, rerender } = setup(source)
    const svg = await screen.findByTestId('mermaid-svg')
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    const img = container.querySelector('img')
    const renders = mermaidMock.render.mock.calls.length
    const next: MarkdownViewProps = {
      ...props,
      loadImage: vi.fn(async () => 'data:image/png;base64,BBBB'),
      onOpenLink: vi.fn(),
      onOpenExternal: vi.fn(),
    }
    rerender(<MarkdownView {...next} />)
    rerender(<MarkdownView {...next} onOpenLink={vi.fn()} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(props.loadImage).toHaveBeenCalledTimes(1)
    expect(next.loadImage).not.toHaveBeenCalled()
    expect(mermaidMock.render).toHaveBeenCalledTimes(renders)
    expect(container.querySelector('img')).toBe(img)
    expect(screen.getByTestId('mermaid-svg')).toBe(svg)
  })

  it('calls the latest onOpenLink after a rerender', () => {
    const { props, rerender } = setup('[next](b.md)')
    const onOpenLink = vi.fn()
    rerender(<MarkdownView {...props} onOpenLink={onOpenLink} />)
    click(screen.getByText('next'))
    expect(onOpenLink).toHaveBeenCalledWith('docs/b.md')
    expect(props.onOpenLink).not.toHaveBeenCalled()
  })

  describe('raw HTML', () => {
    it('does not create a script element', () => {
      const { container } = setup('<script>alert(1)</script>\n\nInline <script>alert(2)</script> text')
      expect(container.querySelector('script')).toBeNull()
      expect(document.querySelector('script')).toBeNull()
      expect(container.textContent).toContain('<script>alert(1)</script>')
    })

    it('does not create an img with an onerror attribute', () => {
      const { container } = setup('<img src=x onerror="alert(1)">\n\ntext <img src=x onerror=alert(1)> more')
      expect(container.querySelector('img[onerror]')).toBeNull()
      expect(document.querySelector('[onerror]')).toBeNull()
    })

    it('does not render other dangerous elements', () => {
      const { container } = setup(
        '<iframe src="https://evil.example.com"></iframe>\n\n<a href="javascript:alert(1)">x</a>\n\n<svg onload=alert(1)></svg>',
      )
      expect(container.querySelector('iframe, svg, [onload]')).toBeNull()
      expect(container.querySelector('a')).toBeNull()
    })
  })

  describe('links', () => {
    it('opens a relative link in the viewer', () => {
      const { props } = setup('[next](b.md)')
      const event = click(screen.getByText('next'))
      expect(props.onOpenLink).toHaveBeenCalledWith('docs/b.md')
      expect(event.defaultPrevented).toBe(true)
      expect(props.onOpenExternal).not.toHaveBeenCalled()
    })

    it('does not put a navigable href on a relative link', () => {
      setup('[next](b.md)')
      expect(screen.getByText('next').closest('[href]')).toBeNull()
    })

    it('opens a relative link from the keyboard', () => {
      const { props } = setup('[next](../README.md#top)')
      fireEvent.keyDown(screen.getByText('next'), { key: 'Enter' })
      expect(props.onOpenLink).toHaveBeenCalledWith('README.md')
    })

    it('calls onOpenExternal for an external link and does not navigate', () => {
      const { props } = setup('[site](https://example.com/x)')
      const event = click(screen.getByText('site'))
      expect(props.onOpenExternal).toHaveBeenCalledWith('https://example.com/x')
      expect(event.defaultPrevented).toBe(true)
      expect(props.onOpenLink).not.toHaveBeenCalled()
    })

    it('handles GFM autolinks as external', () => {
      const { props } = setup('see https://example.com/auto now')
      click(screen.getByText('https://example.com/auto'))
      expect(props.onOpenExternal).toHaveBeenCalledWith('https://example.com/auto')
    })

    it.each([
      ['[x](javascript:alert(1))'],
      ['[x](JaVaScRiPt:alert(1))'],
      ['[x](  javascript:alert(1)  )'],
      ['[x](java&#x09;script:alert(1))'],
      ['[x][r]\n\n[r]: javascript:alert(1)'],
      ['<javascript:alert(1)>'],
      ['[x](data:text/html,<script>alert(1)</script>)'],
      ['[x](vbscript:msgbox(1))'],
      ['[x](file:///etc/passwd)'],
    ])('never renders a navigable href for %s', (md) => {
      const { container, props } = setup(md)
      for (const el of container.querySelectorAll('[href]')) {
        expect(el.getAttribute('href')).toMatch(/^https?:\/\//)
      }
      expect(container.innerHTML).not.toMatch(/href="\s*(javascript|vbscript|data|file):/i)
      for (const el of container.querySelectorAll('.markdown-body *')) click(el)
      expect(props.onOpenExternal).not.toHaveBeenCalled()
      expect(props.onOpenLink).not.toHaveBeenCalled()
    })

    it('scrolls to the heading an anchor-only link names, GitHub-style, repeats numbered', () => {
      const scroll = vi.fn()
      const original = HTMLElement.prototype.scrollIntoView
      HTMLElement.prototype.scrollIntoView = scroll
      try {
        const { container, props } = setup(
          '[jump](#getting-started) [again](#usage-1) [nowhere](#missing)\n\n## Getting Started\n\n## Usage\n\n### Usage\n',
        )
        const jump = screen.getByText('jump')
        expect(jump.closest('[href]')).toBeNull()
        expect(jump).toHaveAttribute('role', 'link')
        click(jump)
        expect(scroll.mock.contexts.at(-1)).toBe(container.querySelector('h2'))
        fireEvent.keyDown(screen.getByText('again'), { key: 'Enter' })
        expect(scroll.mock.contexts.at(-1)).toBe(container.querySelector('h3'))
        click(screen.getByText('nowhere'))
        expect(scroll).toHaveBeenCalledTimes(2)
        expect(props.onOpenLink).not.toHaveBeenCalled()
        // No ids: a heading must not take an id the app's own elements use.
        expect(container.querySelector('[id]')).toBeNull()
      } finally {
        HTMLElement.prototype.scrollIntoView = original
      }
    })

    it('opens a link to lines of a file (#L10-L12) at those lines', () => {
      const { props } = setup('[code](../src/app.ts#L10-L12) [doc](b.md#usage)')
      click(screen.getByText('code'))
      expect(props.onOpenLink).toHaveBeenCalledWith('src/app.ts', { start: 10, end: 12 })
      click(screen.getByText('doc'))
      expect(props.onOpenLink).toHaveBeenLastCalledWith('docs/b.md')
    })

    it('renders a link escaping the root as plain text', () => {
      const { container, props } = setup('[up](../../../etc/passwd)')
      expect(container.querySelector('a')).toBeNull()
      click(screen.getByText('up'))
      expect(props.onOpenLink).not.toHaveBeenCalled()
    })
  })

  describe('images', () => {
    it('loads a relative image through loadImage and renders the returned src', async () => {
      const { container, props } = setup('![logo](img/logo.png)')
      await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
      expect(props.loadImage).toHaveBeenCalledWith('docs/img/logo.png')
      const img = container.querySelector('img')!
      expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA')
      expect(img).toHaveAttribute('alt', 'logo')
    })

    it('shows a placeholder when loadImage returns null', async () => {
      const { container } = setup('![missing](nope.png)', { loadImage: vi.fn(async () => null) })
      await waitFor(() => expect(container.querySelector('.md-img-missing')).not.toBeNull())
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('.md-img-missing')).toHaveAttribute('title')
      expect(container.querySelector('.md-img-missing')).toHaveTextContent('missing')
    })

    it('shows a placeholder when loadImage rejects', async () => {
      const { container } = setup('![bad](bad.png)', { loadImage: vi.fn(async () => Promise.reject(new Error('x'))) })
      await waitFor(() => expect(container.querySelector('.md-img-missing')).not.toBeNull())
      expect(container.querySelector('img')).toBeNull()
    })

    it('does not load external images and shows the alt text', () => {
      const { container, props } = setup('![remote pic](https://example.com/a.png)')
      expect(props.loadImage).not.toHaveBeenCalled()
      expect(container.querySelector('img')).toBeNull()
      const placeholder = container.querySelector('.md-img-missing')
      expect(placeholder).toHaveTextContent('remote pic')
      expect(placeholder).toHaveAttribute('title')
    })

    it('does not load images that escape the root', () => {
      const { container, props } = setup('![x](../../secret.png)')
      expect(props.loadImage).not.toHaveBeenCalled()
      expect(container.querySelector('.md-img-missing')).not.toBeNull()
    })
  })
})
