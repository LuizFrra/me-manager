import { useLayoutEffect, useRef, useState } from 'react'
import { ROW_HEIGHT, useVirtualRows } from '../../lib/useVirtualRows'

export interface VirtualRowListProps {
  className: string
  /** The scroll container's accessible name. */
  label: string
  count: number
  /** The selected row, scrolled into view when the selection changes (or first appears); -1 for none. */
  selectedIndex: number
  /** What is selected (a path), so a re-render with the same selection doesn't scroll it back into view. */
  selectedKey?: string
  /**
   * Renders row `index` as a focusable element carrying `data-row={index}`, with `style` (its position while the
   * list is virtual).
   */
  renderRow: (index: number, style: React.CSSProperties | undefined) => React.ReactNode
  /** Extra keys for the focused row (the tree's ←/→): returns the row to move focus to, or null. */
  onRowKey?: (e: React.KeyboardEvent, index: number) => number | null
}

const rowOf = (el: EventTarget | null): number | null => {
  const row = el instanceof HTMLElement ? el.closest<HTMLElement>('[data-row]') : null
  return row ? Number(row.dataset.row) : null
}

/**
 * A list of fixed-height rows in its own scroll container, rendering only the rows in view once there are many
 * (see useVirtualRows). The focused row stays rendered while scrolled away, so focus is never lost to a row that
 * was taken out, and ↑/↓/Home/End/PageUp/PageDown move focus between rows, scrolling as needed.
 */
export function VirtualRowList(p: VirtualRowListProps): React.JSX.Element {
  const { setContainer, getContainer, ready, virtual, start, end, totalHeight, scrollToIndex } =
    useVirtualRows<HTMLDivElement>({
      count: p.count,
    })
  const [focused, setFocused] = useState<number | null>(null)
  const pendingFocus = useRef<number | null>(null)

  // The selection scrolls into view once per selected path: when it changes, or when its row first shows up
  // (the file list loaded, its folder opened). Not on every render, which would fight the user's scrolling.
  const scrolledTo = useRef<string | undefined>(undefined)
  const { selectedIndex, selectedKey } = p
  useLayoutEffect(() => {
    if (selectedKey === undefined) scrolledTo.current = undefined
    if (!ready || selectedIndex < 0 || selectedKey === undefined || scrolledTo.current === selectedKey) return
    if (scrollToIndex(selectedIndex)) scrolledTo.current = selectedKey
  }, [ready, selectedIndex, selectedKey, scrollToIndex])

  useLayoutEffect(() => {
    const index = pendingFocus.current
    if (index === null) return
    pendingFocus.current = null
    getContainer()?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus()
  })

  const moveTo = (index: number): void => {
    const next = Math.min(Math.max(index, 0), p.count - 1)
    if (next < 0) return
    scrollToIndex(next)
    pendingFocus.current = next
    setFocused(next)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const index = rowOf(e.target)
    if (index === null || e.altKey || e.ctrlKey || e.metaKey) return
    const page = Math.max(1, Math.floor((getContainer()?.clientHeight || ROW_HEIGHT * 10) / ROW_HEIGHT) - 1)
    const steps: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: p.count - 1,
      PageDown: index + page,
      PageUp: index - page,
    }
    const target = e.key in steps ? steps[e.key] : (p.onRowKey?.(e, index) ?? null)
    if (target === null) return
    e.preventDefault()
    moveTo(target)
  }

  const indices: number[] = []
  for (let i = start; i < end; i++) indices.push(i)
  if (virtual && focused !== null && focused < p.count && (focused < start || focused >= end)) {
    indices.push(focused)
    indices.sort((a, b) => a - b)
  }

  return (
    <div
      ref={setContainer}
      className={`${p.className} row-list`}
      role="group"
      aria-label={p.label}
      onKeyDown={onKeyDown}
      onFocus={(e) => setFocused(rowOf(e.target))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null)
      }}
    >
      {virtual ? (
        <div className="virtual-rows" style={{ height: totalHeight }}>
          {indices.map((i) => p.renderRow(i, { position: 'absolute', top: i * ROW_HEIGHT, height: ROW_HEIGHT }))}
        </div>
      ) : (
        indices.map((i) => p.renderRow(i, undefined))
      )}
    </div>
  )
}
