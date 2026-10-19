import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_VIEWPORT,
  OVERSCAN,
  ROW_HEIGHT,
  scrollTopFor,
  useVirtualRows,
  visibleRange,
  VIRTUALIZE_ABOVE,
} from './useVirtualRows'

describe('visibleRange', () => {
  it('slices the rows in view by scrollTop and height, with overscan on both sides', () => {
    // 10 px rows, a 100 px viewport scrolled to 500: rows 50..59 are in view.
    expect(visibleRange(1000, 10, 500, 100, 5)).toEqual({ start: 45, end: 65 })
    expect(visibleRange(1000, 10, 505, 100, 0)).toEqual({ start: 50, end: 61 }) // a partly shown row counts
  })

  it('clamps at the top and the bottom', () => {
    expect(visibleRange(1000, 10, 0, 100, 5)).toEqual({ start: 0, end: 15 })
    expect(visibleRange(1000, 10, -40, 100, 5)).toEqual({ start: 0, end: 15 }) // elastic overscroll
    expect(visibleRange(100, 10, 950, 100, 5)).toEqual({ start: 90, end: 100 })
    expect(visibleRange(100, 10, 99_999, 100, 5)).toEqual({ start: 100, end: 100 })
    expect(visibleRange(0, 10, 0, 100, 5)).toEqual({ start: 0, end: 0 })
  })
})

describe('scrollTopFor', () => {
  it('scrolls as little as needed to show a row, and not at all when it is in view', () => {
    // 22 px rows in a 220 px viewport scrolled to 440 (rows 20..29 in view).
    expect(scrollTopFor(25, 22, 440, 220)).toBeNull()
    expect(scrollTopFor(20, 22, 440, 220)).toBeNull()
    expect(scrollTopFor(29, 22, 440, 220)).toBeNull()
    expect(scrollTopFor(5, 22, 440, 220)).toBe(110) // above: its top at the top
    expect(scrollTopFor(30, 22, 440, 220)).toBe(30 * 22 + 22 - 220) // below: its bottom at the bottom
    expect(scrollTopFor(1000, 22, 0, 220)).toBe(1000 * 22 + 22 - 220)
    expect(scrollTopFor(3, 22, 0, 10)).toBe(66) // a viewport smaller than a row: its top
  })
})

function List({ count, scrollTo }: { count: number; scrollTo?: number }): React.JSX.Element {
  const { setContainer, virtual, totalHeight, start, end, scrollToIndex } = useVirtualRows<HTMLDivElement>({ count })
  return (
    <>
      <button onClick={() => scrollTo !== undefined && scrollToIndex(scrollTo)}>go</button>
      <div ref={setContainer} data-testid="scroller" data-virtual={virtual} data-total={totalHeight}>
        {Array.from({ length: end - start }, (_, k) => (
          <div key={start + k} className="row">
            {start + k}
          </div>
        ))}
      </div>
    </>
  )
}

const rendered = (): number[] => [...document.querySelectorAll('.row')].map((r) => Number(r.textContent))

describe('useVirtualRows', () => {
  it('renders every row up to the threshold', () => {
    render(<List count={VIRTUALIZE_ABOVE} />)
    expect(rendered()).toHaveLength(VIRTUALIZE_ABOVE)
    expect(screen.getByTestId('scroller')).toHaveAttribute('data-virtual', 'false')
  })

  it('renders a window above it, following the scroll position and the container height', () => {
    render(<List count={5000} />)
    const scroller = screen.getByTestId('scroller')
    expect(scroller).toHaveAttribute('data-virtual', 'true')
    expect(scroller).toHaveAttribute('data-total', String(5000 * ROW_HEIGHT))
    // No layout in jsdom: the fallback viewport.
    expect(rendered()).toEqual(
      Array.from({ length: Math.ceil(FALLBACK_VIEWPORT / ROW_HEIGHT) + OVERSCAN }, (_, i) => i),
    )

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 220 })
    scroller.scrollTop = 1000 * ROW_HEIGHT
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(rendered()[0]).toBe(1000 - OVERSCAN)
    expect(rendered().at(-1)).toBe(1000 + 10 + OVERSCAN - 1)
  })

  it('scrolls a row into view on request and renders it at once', () => {
    render(<List count={5000} scrollTo={3210} />)
    expect(rendered()).not.toContain(3210)
    act(() => screen.getByRole('button', { name: 'go' }).click())
    expect(rendered()).toContain(3210)
    expect(screen.getByTestId('scroller').scrollTop).toBe(3210 * ROW_HEIGHT + ROW_HEIGHT - FALLBACK_VIEWPORT)
  })
})

/** Rows in a body of their own, 100 px below the top of an ancestor that scrolls (like a table in the viewer). */
function NestedList({ count, scrollTo }: { count: number; scrollTo?: number }): React.JSX.Element {
  const { setContainer, start, end, scrollToIndex } = useVirtualRows<HTMLDivElement>({ count, scrollParent: true })
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <button onClick={() => scrollTo !== undefined && scrollToIndex(scrollTo)}>go</button>
      <div ref={setContainer} data-testid="rows">
        {Array.from({ length: end - start }, (_, k) => (
          <div key={start + k} className="row">
            {start + k}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The same, with no scrolling ancestor. */
function NestedListWithoutScroller(): React.JSX.Element {
  const { setContainer, start, end } = useVirtualRows<HTMLDivElement>({ count: 5000, scrollParent: true })
  return (
    <div ref={setContainer}>
      {Array.from({ length: end - start }, (_, k) => (
        <div key={start + k} className="row">
          {start + k}
        </div>
      ))}
    </div>
  )
}

/**
 * jsdom has no layout: gives the scroller a height, and the rows a position that follows its scrollTop, `above`
 * px below its top.
 */
function layOut(height: number, above: number): HTMLElement {
  const scroller = screen.getByTestId('scroller')
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: height })
  screen.getByTestId('rows').getBoundingClientRect = () => ({ top: above - scroller.scrollTop }) as DOMRect
  return scroller
}

describe('useVirtualRows in a scroll parent', () => {
  it('follows the scrolling ancestor, from where the rows start in it', () => {
    render(<NestedList count={5000} />)
    const scroller = layOut(220, 100)
    scroller.scrollTop = 100 + 1000 * ROW_HEIGHT
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(rendered()[0]).toBe(1000 - OVERSCAN)
    expect(rendered().at(-1)).toBe(1000 + 10 + OVERSCAN - 1)
  })

  it('scrolls the ancestor to show a row', () => {
    render(<NestedList count={5000} scrollTo={3210} />)
    const scroller = layOut(220, 100)
    act(() => screen.getByRole('button', { name: 'go' }).click())
    expect(rendered()).toContain(3210)
    expect(scroller.scrollTop).toBe(100 + 3210 * ROW_HEIGHT + ROW_HEIGHT - 220)
  })

  it('renders the first rows when no ancestor scrolls', () => {
    render(<NestedListWithoutScroller />)
    expect(rendered()[0]).toBe(0)
    expect(rendered()).toHaveLength(Math.ceil(FALLBACK_VIEWPORT / ROW_HEIGHT) + OVERSCAN)
  })
})
