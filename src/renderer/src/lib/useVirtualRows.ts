import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** Lists with more rows than this render only the rows in view (plus OVERSCAN on each side). */
export const VIRTUALIZE_ABOVE = 300
/** The height of a tree or change row, in px (see `.tree-row, .change-row` in styles.css). */
export const ROW_HEIGHT = 22
export const OVERSCAN = 10
/** The viewport assumed while the scroll container has no height yet (before layout, and always in jsdom). */
export const FALLBACK_VIEWPORT = 600

/** Rows `start` (inclusive) to `end` (exclusive). */
export interface RowRange {
  start: number
  end: number
}

/** The rows to render at a scroll position: the ones in view, plus `overscan` rows above and below. */
export function visibleRange(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number,
  overscan = OVERSCAN,
): RowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rowHeight)
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight)
  const end = Math.min(count, last + overscan)
  return { start: Math.min(Math.max(0, first - overscan), end), end }
}

/**
 * The scrollTop that brings row `index` fully into view with the least movement (like scrollIntoView's
 * `block: 'nearest'`), or null when it already is.
 */
export function scrollTopFor(index: number, rowHeight: number, scrollTop: number, viewport: number): number | null {
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewport) return Math.max(0, viewport >= rowHeight ? bottom - viewport : top)
  return null
}

/** The nearest ancestor of `el` that scrolls vertically, or null. */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return p
  }
  return null
}

export interface VirtualRows<E extends HTMLElement> {
  /**
   * The callback ref for the scroll container; the rows must be its only content, `rowHeight` each, from the top.
   * With `scrollParent`, for the element that holds just the rows, from its top (a table's body).
   */
  setContainer: (el: E | null) => void
  /** The container (for event handlers and effects), or null before it is mounted. */
  getContainer: () => E | null
  /** Whether the container is mounted, so that scrollToIndex can work. */
  ready: boolean
  /** Whether only a window of the rows is rendered (more than `threshold` rows). */
  virtual: boolean
  /** The rows to render; every row when not virtual. */
  start: number
  end: number
  /** The height of all the rows, for the spacer that keeps the scrollbar right. */
  totalHeight: number
  /** Scrolls the container just enough to show row `index`, rendering it at once; false before it is mounted. */
  scrollToIndex: (index: number) => boolean
}

/**
 * How far the rows are scrolled past the top of the scroller's viewport: its scrollTop when they are all it holds,
 * else from where both are on screen (negative while the rows start below the top).
 */
function rowsScrolled(rows: HTMLElement, scroller: HTMLElement): number {
  if (rows === scroller) return scroller.scrollTop
  return scroller.getBoundingClientRect().top + scroller.clientTop - rows.getBoundingClientRect().top
}

/**
 * A fixed-row-height virtual list. The scroll position (to the row) and the container's height are read on scroll
 * and on resize, so the list re-renders when a row boundary is crossed, not on every scrolled pixel; the window of
 * rows is derived from them and the row count during render.
 *
 * With `scrollParent`, the rows scroll with the container's nearest scrolling ancestor, where other content may
 * come before them: a table's rows, in the viewer's body. Without one, only the first rows are rendered.
 */
export function useVirtualRows<E extends HTMLElement>({
  count,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
  threshold = VIRTUALIZE_ABOVE,
  scrollParent = false,
}: {
  count: number
  rowHeight?: number
  overscan?: number
  threshold?: number
  scrollParent?: boolean
}): VirtualRows<E> {
  const containerRef = useRef<E | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  // The container itself, so that the listeners move to a new one (a table replaced by another).
  const [container, setContainerState] = useState<E | null>(null)
  // The first row scrolled to (the top, rounded down to a row) and the viewport height.
  const [view, setView] = useState({ top: 0, height: FALLBACK_VIEWPORT })
  const virtual = count > threshold
  const range = useMemo(
    () => visibleRange(count, rowHeight, view.top, view.height, overscan),
    [count, rowHeight, view, overscan],
  )

  const setContainer = useCallback(
    (el: E | null) => {
      containerRef.current = el
      scrollerRef.current = el && (scrollParent ? scrollParentOf(el) : el)
      setContainerState(el)
    },
    [scrollParent],
  )
  const getContainer = useCallback(() => containerRef.current, [])

  const read = useCallback(() => {
    const el = containerRef.current
    const scroller = scrollerRef.current
    if (!el || !scroller) return
    const top = Math.floor(rowsScrolled(el, scroller) / rowHeight) * rowHeight
    const next = { top, height: scroller.clientHeight || FALLBACK_VIEWPORT }
    setView((prev) => (prev.top === next.top && prev.height === next.height ? prev : next))
  }, [rowHeight])

  // A ResizeObserver reports the size once when it starts observing, so the real height is read then too. The
  // position is read at once: a scroll parent may have been scrolled before the rows came.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!container || !scroller || !virtual) return
    read()
    scroller.addEventListener('scroll', read, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    observer?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', read)
      observer?.disconnect()
    }
  }, [container, read, virtual])

  const scrollToIndex = useCallback(
    (index: number): boolean => {
      const el = containerRef.current
      const scroller = scrollerRef.current
      if (!el || !scroller || index < 0) return false
      const scrolled = rowsScrolled(el, scroller)
      const top = scrollTopFor(index, rowHeight, scrolled, scroller.clientHeight || FALLBACK_VIEWPORT)
      if (top !== null) scroller.scrollTop += top - scrolled
      read() // the scroll event comes later (in jsdom, never): show the row now
      return true
    },
    [rowHeight, read],
  )

  return {
    setContainer,
    getContainer,
    ready: container !== null,
    virtual,
    start: virtual ? range.start : 0,
    end: virtual ? range.end : count,
    totalHeight: count * rowHeight,
    scrollToIndex,
  }
}
