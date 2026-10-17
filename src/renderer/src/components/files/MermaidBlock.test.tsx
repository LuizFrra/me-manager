import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))
vi.mock('mermaid', () => ({ default: mermaidMock }))

import { MermaidBlock } from './MermaidBlock'

describe('MermaidBlock', () => {
  beforeEach(() => {
    mermaidMock.render.mockReset()
  })

  it('initializes mermaid in strict mode and injects the rendered SVG', async () => {
    mermaidMock.render.mockResolvedValue({ svg: '<svg data-testid="diagram"><g></g></svg>', diagramType: 'flowchart' })
    render(<MermaidBlock code="graph TD; A-->B" />)

    expect(await screen.findByTestId('diagram')).toBeInTheDocument()
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' }),
    )
    const [id, code] = mermaidMock.render.mock.calls[0]
    expect(id).toMatch(/^[a-zA-Z][\w-]*$/)
    expect(code).toBe('graph TD; A-->B')
  })

  it('initializes mermaid only once', async () => {
    mermaidMock.render.mockResolvedValue({ svg: '<svg data-testid="d"></svg>', diagramType: 'flowchart' })
    render(<MermaidBlock code="graph TD; A-->B" />)
    render(<MermaidBlock code="graph TD; C-->D" />)
    await waitFor(() => expect(screen.getAllByTestId('d')).toHaveLength(2))
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1)
    const ids = mermaidMock.render.mock.calls.map((c) => c[0])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('shows the error message and the source on failure', async () => {
    mermaidMock.render.mockRejectedValue(new Error('Parse error on line 1'))
    const { container } = render(<MermaidBlock code="graph ??? nope" />)

    expect(await screen.findByText('Parse error on line 1')).toBeInTheDocument()
    const error = container.querySelector('.mermaid-error')
    expect(error).not.toBeNull()
    expect(error!.querySelector('pre')).toHaveTextContent('graph ??? nope')
  })

  it('ignores a result that arrives after unmount', async () => {
    let resolve!: (v: { svg: string }) => void
    mermaidMock.render.mockReturnValue(new Promise((r) => (resolve = r)))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<MermaidBlock code="graph TD; A-->B" />)
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled())
    unmount()
    resolve({ svg: '<svg data-testid="late"></svg>' })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('late')).toBeNull()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('neutralizes links inside the diagram so they cannot navigate the window', async () => {
    mermaidMock.render.mockResolvedValue({
      svg:
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a href="https://evil.example.com" xlink:href="https://evil.example.com" target="_top"><text>A</text></a>' +
        '</svg>',
      diagramType: 'flowchart',
    })
    const { container } = render(<MermaidBlock code="graph TD; A" />)
    await waitFor(() => expect(container.querySelector('svg a')).not.toBeNull())

    const a = container.querySelector('svg a')!
    expect(a.hasAttribute('href')).toBe(false)
    expect(a.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(false)
    expect(a.hasAttribute('target')).toBe(false)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(a.querySelector('text')!, event)
    expect(event.defaultPrevented).toBe(true)
  })
})
