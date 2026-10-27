import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  run: () => void
  /** Shown before the label. */
  icon?: React.ReactNode
}

/** Keeps a menu this far from the window's right edge. */
const MENU_WIDTH = 220

/**
 * A popup menu at (x, y), on the body (inside a bar it would be clipped). Focus starts on the first item; ↑/↓
 * (wrapping), Home and End move it, Enter or a click runs an item, and Esc, Tab, a click elsewhere or leaving the
 * window close it. `trigger` gets the focus back.
 */
export function PopupMenu({
  label,
  x,
  y,
  trigger,
  items,
  onClose,
  className = 'tab-menu',
  triggerToggles = false,
}: {
  label: string
  x: number
  y: number
  trigger: HTMLElement
  items: MenuItem[]
  onClose: () => void
  className?: string
  /** A click on the trigger is left to it (a menu button toggles its menu); otherwise it closes the menu too. */
  triggerToggles?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Opened near the bottom of the window (a right click low in the terminal), the menu opens upwards instead of
  // running off-screen.
  const [top, setTop] = useState(y)
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    setTop(y + height > window.innerHeight ? Math.max(0, Math.min(y, window.innerHeight) - height) : y)
  }, [y, items.length])
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !(triggerToggles && trigger.contains(target))) onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, trigger, triggerToggles])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const focus = (i: number): void => buttons[(i + buttons.length) % buttons.length]?.focus()
    if (e.key === 'ArrowDown') focus(at + 1)
    else if (e.key === 'ArrowUp') focus(at - 1)
    else if (e.key === 'Home') focus(0)
    else if (e.key === 'End') focus(buttons.length - 1)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      trigger.focus()
      onClose()
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div
      ref={ref}
      className={className}
      role="menu"
      aria-label={label}
      style={{ left: Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH)), top }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            trigger.focus()
            onClose()
            item.run()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
