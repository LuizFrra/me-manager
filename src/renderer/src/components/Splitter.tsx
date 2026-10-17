import { useRef } from 'react'
import { clampFraction, DEFAULT_PANEL_FRACTION, MAX_PANEL_FRACTION } from '../lib/panelState'

export interface SplitterProps {
  /** Width of the panel to the right, as a fraction of the parent's width. */
  fraction: number
  onChange: (fraction: number) => void
  /** Called once a drag or key press is done, to persist the width. */
  onCommit: (fraction: number) => void
}

const KEY_STEP = 0.02

/** Vertical drag handle between the terminal and the side panel (its parent's last child). */
export function Splitter({ fraction, onChange, onCommit }: SplitterProps): React.JSX.Element {
  const drag = useRef<{ last: number } | null>(null)

  const widthOf = (el: HTMLElement): number => el.parentElement?.getBoundingClientRect().width ?? 0
  const set = (next: number, el: HTMLElement): number => {
    const value = clampFraction(next, widthOf(el) || undefined)
    onChange(value)
    return value
  }
  const end = (): void => {
    if (!drag.current) return
    document.body.classList.remove('resizing')
    onCommit(drag.current.last)
    drag.current = null
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize files panel"
      aria-valuemin={0}
      aria-valuemax={Math.round(MAX_PANEL_FRACTION * 100)}
      aria-valuenow={Math.round(fraction * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        document.body.classList.add('resizing')
        drag.current = { last: fraction }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const rect = e.currentTarget.parentElement?.getBoundingClientRect()
        if (!rect || rect.width === 0) return
        drag.current.last = set((rect.right - e.clientX) / rect.width, e.currentTarget)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={(e) => onCommit(set(DEFAULT_PANEL_FRACTION, e.currentTarget))}
      onKeyDown={(e) => {
        const delta = e.key === 'ArrowLeft' ? KEY_STEP : e.key === 'ArrowRight' ? -KEY_STEP : 0
        if (!delta) return
        e.preventDefault()
        onCommit(set(fraction + delta, e.currentTarget))
      }}
    />
  )
}
