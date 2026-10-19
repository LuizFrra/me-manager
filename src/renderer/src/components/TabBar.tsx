import { useCallback, useState } from 'react'
import { RUN_WINDOW } from '../../../shared/runCommand'
import type { TabInfo } from '../../../shared/types'
import { PANEL_SHORTCUT_LABEL, shortcutLabel } from '../lib/shortcuts'
import { PopupMenu, type MenuItem } from './PopupMenu'

/** Where a tab's menu opened, and the tab button that gets the focus back when it closes. */
interface OpenMenu {
  tab: TabInfo
  x: number
  y: number
  trigger: HTMLElement
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
      {shownMenu && (
        <PopupMenu
          label={`Tab ${shownMenu.tab.name}`}
          x={shownMenu.x}
          y={shownMenu.y}
          trigger={shownMenu.trigger}
          items={menuItems(menuTab ?? shownMenu.tab)}
          onClose={closeMenu}
        />
      )}
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
