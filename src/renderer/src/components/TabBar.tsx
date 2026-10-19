import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RUN_WINDOW } from '../../../shared/runCommand'
import type { TabInfo } from '../../../shared/types'
import { PANEL_SHORTCUT_LABEL, shortcutLabel } from '../lib/shortcuts'

interface MenuItem {
  label: string
  run: () => void
}

/** Where a tab's menu opened, and the tab button that gets the focus back when it closes. */
interface OpenMenu {
  tab: TabInfo
  x: number
  y: number
  trigger: HTMLElement
}

/** Keeps a menu this far from the window's right edge. */
const MENU_WIDTH = 200

/**
 * A tab's context menu: focus starts on the first item; ↑/↓ (wrapping), Home and End move it, Enter or a click
 * runs an item, and Esc, Tab, a click elsewhere or leaving the window close it.
 */
function TabMenu({
  menu,
  items,
  onClose,
}: {
  menu: OpenMenu
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const focus = (i: number): void => buttons[(i + buttons.length) % buttons.length]?.focus()
    if (e.key === 'ArrowDown') focus(at + 1)
    else if (e.key === 'ArrowUp') focus(at - 1)
    else if (e.key === 'Home') focus(0)
    else if (e.key === 'End') focus(buttons.length - 1)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      menu.trigger.focus()
      onClose()
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  // On the body: inside the tab list it would be clipped by the bar, and a tab list holds only tabs.
  return createPortal(
    <div
      ref={ref}
      className="tab-menu"
      role="menu"
      aria-label={`Tab ${menu.tab.name}`}
      style={{ left: Math.max(0, Math.min(menu.x, window.innerWidth - MENU_WIDTH)), top: menu.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            menu.trigger.focus()
            onClose()
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

export function TabBar(props: {
  tabs: TabInfo[]
  onSelect: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onRestartClaude: () => void
  onCopyTranscript: (index: number) => void
  onSaveTranscript: (index: number) => void
  /** Restart and Stop in the run tab's menu. */
  onRestartRun?: () => void
  onStopRun?: () => void
  panelOpen: boolean
  onTogglePanel: () => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // A tab that closed meanwhile (from the terminal, say) takes its menu with it.
  // Its items follow the tab as it is now: a run tab that stopped meanwhile has no Stop.
  const menuTab = menu && props.tabs.find((t) => t.index === menu.tab.index)
  const shownMenu = menu && menuTab ? menu : null
  const hasClaude = props.tabs.some((t) => t.name === 'claude')

  // Right-click, or the Menu key / Shift+F10 on a focused tab (no pointer position: open under the tab).
  const openMenu = (e: React.MouseEvent<HTMLElement>, tab: TabInfo): void => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const fromKeyboard = e.clientX === 0 && e.clientY === 0
    setMenu({
      tab,
      x: fromKeyboard ? rect.left : e.clientX,
      y: fromKeyboard ? rect.bottom : e.clientY,
      trigger: e.currentTarget,
    })
  }
  const menuItems = (tab: TabInfo): MenuItem[] => {
    const { onRestartRun, onStopRun } = props
    const run: MenuItem[] = []
    if (tab.name === RUN_WINDOW && onRestartRun) run.push({ label: 'Restart', run: onRestartRun })
    if (tab.name === RUN_WINDOW && !tab.dead && onStopRun) run.push({ label: 'Stop', run: onStopRun })
    return [
      ...run,
      { label: 'Copy transcript', run: () => props.onCopyTranscript(tab.index) },
      { label: 'Save transcript…', run: () => props.onSaveTranscript(tab.index) },
      { label: 'Close tab', run: () => props.onClose(tab.index) },
    ]
  }

  return (
    <div className="tabbar" role="tablist">
      {props.tabs.map((t) => (
        <div key={t.index} className={t.active ? 'tab active' : 'tab'}>
          <button
            role="tab"
            aria-selected={t.active}
            aria-haspopup="menu"
            className={t.dead ? 'dead' : undefined}
            title={t.dead ? 'Stopped: the command exited. Restart it from the tab menu.' : undefined}
            onClick={() => props.onSelect(t.index)}
            onContextMenu={(e) => openMenu(e, t)}
          >
            {t.name}
          </button>
          <button className="tab-close" aria-label={`Close tab ${t.name}`} onClick={() => props.onClose(t.index)}>
            ×
          </button>
        </div>
      ))}
      {shownMenu && <TabMenu menu={shownMenu} items={menuItems(menuTab ?? shownMenu.tab)} onClose={closeMenu} />}
      <button
        className="tab-new"
        aria-label="New shell tab"
        title={`New shell tab (${shortcutLabel('newTab')})`}
        onClick={props.onNew}
      >
        +
      </button>
      <span className="tabbar-spacer" />
      {!hasClaude && props.tabs.length > 0 && (
        <button className="restart" onClick={props.onRestartClaude}>
          Restart Claude
        </button>
      )}
      <button
        className={props.panelOpen ? 'panel-toggle active' : 'panel-toggle'}
        aria-label="Toggle files panel"
        aria-pressed={props.panelOpen}
        title={`Files panel (${PANEL_SHORTCUT_LABEL})`}
        onClick={props.onTogglePanel}
      >
        ⊞
      </button>
    </div>
  )
}
