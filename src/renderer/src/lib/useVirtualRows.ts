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

export interface VirtualRows<E extends HTMLElement> {
  /** The callback ref for the scroll container; the rows must be its only content, `rowHeight` each, from the top. */
  setContainer: (el: E | null) => void
  /** The scroll container (for event handlers and effects), or null before it is mounted. */
  getContainer: () => E | null
  /** Whether the scroll container is mounted, so that scrollToIndex can work. */
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
 * A fixed-row-height virtual list. The scroll position (to the row) and the container's height are read on scroll
 * and on resize, so the list re-renders when a row boundary is crossed, not on every scrolled pixel; the window of
 * rows is derived from them and the row count during render.
 */
export function useVirtualRows<E extends HTMLElement>({
  count,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
  threshold = VIRTUALIZE_ABOVE,
}: {
  count: number
  rowHeight?: number
  overscan?: number
  threshold?: number
}): VirtualRows<E> {
  const containerRef = useRef<E | null>(null)
  const [ready, setReady] = useState(false)
  // The first row scrolled to (the top, rounded down to a row) and the viewport height.
  const [view, setView] = useState({ top: 0, height: FALLBACK_VIEWPORT })
  const virtual = count > threshold
  const range = useMemo(
    () => visibleRange(count, rowHeight, view.top, view.height, overscan),
    [count, rowHeight, view, overscan],
  )

  const setContainer = useCallback((el: E | null) => {
    containerRef.current = el
    setReady(el !== null)
  }, [])
  const getContainer = useCallback(() => containerRef.current, [])

  const read = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const next = { top: Math.floor(el.scrollTop / rowHeight) * rowHeight, height: el.clientHeight || FALLBACK_VIEWPORT }
    setView((prev) => (prev.top === next.top && prev.height === next.height ? prev : next))
  }, [rowHeight])

  // A ResizeObserver reports the size once when it starts observing, so the real height is read then too.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!ready || !el || !virtual) return
    el.addEventListener('scroll', read, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      observer?.disconnect()
    }
  }, [ready, read, virtual])

  const scrollToIndex = useCallback(
    (index: number): boolean => {
      const el = containerRef.current
      if (!el || index < 0) return false
      const top = scrollTopFor(index, rowHeight, el.scrollTop, el.clientHeight || FALLBACK_VIEWPORT)
      if (top !== null) el.scrollTop = top
      read() // the scroll event comes later (in jsdom, never): show the row now
      return true
    },
    [rowHeight, read],
  )

  return {
    setContainer,
    getContainer,
    ready,
    virtual,
    start: virtual ? range.start : 0,
    end: virtual ? range.end : count,
    totalHeight: count * rowHeight,
    scrollToIndex,
  }
}
