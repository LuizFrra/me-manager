import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../../../shared/types'
import { TabBar } from './TabBar'

const TABS: TabInfo[] = [
  { index: 0, name: 'claude', active: false },
  { index: 3, name: 'shell', active: true },
]

function renderBar(): {
  onCopyTranscript: ReturnType<typeof vi.fn>
  onSaveTranscript: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const handlers = { onCopyTranscript: vi.fn(), onSaveTranscript: vi.fn(), onClose: vi.fn() }
  render(
    <TabBar
      tabs={TABS}
      onSelect={() => {}}
      onNew={() => {}}
      onRestartClaude={() => {}}
      panelOpen={false}
      onTogglePanel={() => {}}
      {...handlers}
    />,
  )
  return handlers
}

const menu = (): HTMLElement => screen.getByRole('menu', { name: 'Tab shell' })

describe('TabBar tab menu', () => {
  it("opens on a tab's context menu with its transcript actions, and runs them for that tab", async () => {
    const user = userEvent.setup()
    const { onCopyTranscript, onSaveTranscript, onClose } = renderBar()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'shell' }))
    expect(
      within(menu())
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Copy transcript', 'Save transcript…', 'Close tab'])
    await user.click(within(menu()).getByRole('menuitem', { name: 'Copy transcript' }))
    expect(onCopyTranscript).toHaveBeenCalledWith(3)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'shell' }))
    await user.click(within(menu()).getByRole('menuitem', { name: 'Save transcript…' }))
    expect(onSaveTranscript).toHaveBeenCalledWith(3)

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'claude' }))
    await user.click(screen.getByRole('menuitem', { name: 'Close tab' }))
    expect(onClose).toHaveBeenCalledWith(0)
  })

  it('works from the keyboard: focus on the first item, arrows move, Esc closes and refocuses the tab', async () => {
    const user = userEvent.setup()
    const { onSaveTranscript } = renderBar()
    const tab = screen.getByRole('tab', { name: 'shell' })
    tab.focus()
    fireEvent.contextMenu(tab) // what the Menu key and Shift+F10 fire
    const items = within(menu()).getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(items[2]).toHaveFocus() // wraps around
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(tab).toHaveFocus()

    fireEvent.contextMenu(tab)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onSaveTranscript).toHaveBeenCalledWith(3)
  })

  it('closes on a click outside, without running anything', async () => {
    const user = userEvent.setup()
    const { onCopyTranscript, onSaveTranscript, onClose } = renderBar()
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'shell' }))
    await user.click(screen.getByRole('button', { name: 'New shell tab' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onCopyTranscript).not.toHaveBeenCalled()
    expect(onSaveTranscript).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('TabBar run tab', () => {
  const runTabs = (dead: boolean): TabInfo[] => [
    { index: 0, name: 'claude', active: false },
    { index: 1, name: 'run', active: true, ...(dead ? { dead: true as const } : {}) },
  ]
  function renderRun(dead: boolean): { onRestartRun: ReturnType<typeof vi.fn>; onStopRun: ReturnType<typeof vi.fn> } {
    const handlers = { onRestartRun: vi.fn(), onStopRun: vi.fn() }
    render(
      <TabBar
        tabs={runTabs(dead)}
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        onRestartClaude={() => {}}
        onCopyTranscript={() => {}}
        onSaveTranscript={() => {}}
        panelOpen={false}
        onTogglePanel={() => {}}
        {...handlers}
      />,
    )
    return handlers
  }

  it("adds Restart and Stop to a running run tab's menu", async () => {
    const user = userEvent.setup()
    const { onRestartRun, onStopRun } = renderRun(false)
    const tab = screen.getByRole('tab', { name: 'run' })
    expect(tab).not.toHaveClass('dead')
    fireEvent.contextMenu(tab)
    const items = within(screen.getByRole('menu', { name: 'Tab run' })).getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'Restart',
      'Stop',
      'Copy transcript',
      'Save transcript…',
      'Close tab',
    ])
    await user.click(items[0])
    fireEvent.contextMenu(tab)
    await user.click(screen.getByRole('menuitem', { name: 'Stop' }))
    expect(onRestartRun).toHaveBeenCalledTimes(1)
    expect(onStopRun).toHaveBeenCalledTimes(1)
  })

  it('marks a stopped run tab, and offers Restart only', () => {
    renderRun(true)
    const tab = screen.getByRole('tab', { name: 'run' })
    expect(tab).toHaveClass('dead')
    expect(tab).toHaveAttribute('title', 'Stopped: the command exited. Restart it from the tab menu.')
    fireEvent.contextMenu(tab)
    expect(screen.getByRole('menuitem', { name: 'Restart' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it("leaves other tabs' menus as they are", () => {
    renderRun(false)
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'claude' }))
    expect(screen.queryByRole('menuitem', { name: 'Restart' })).not.toBeInTheDocument()
  })
})

describe('TabBar keys and pointer', () => {
  const tabs: TabInfo[] = [
    { index: 0, name: 'claude', active: false },
    { index: 3, name: 'shell', active: true },
    { index: 5, name: 'npm run dev -- --host 0.0.0.0 --port 5173', active: false },
  ]
  function renderTabs(): { onSelect: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
    const handlers = { onSelect: vi.fn(), onClose: vi.fn() }
    render(
      <TabBar
        tabs={tabs}
        onNew={() => {}}
        onRestartClaude={() => {}}
        onCopyTranscript={() => {}}
        onSaveTranscript={() => {}}
        panelOpen={false}
        onTogglePanel={() => {}}
        {...handlers}
      />,
    )
    return handlers
  }
  const tab = (name: string | RegExp): HTMLElement => screen.getByRole('tab', { name })

  it('is a named tab list with only the active tab in the Tab order, and no close buttons', () => {
    renderTabs()
    expect(screen.getByRole('tablist', { name: 'Terminal tabs' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([-1, 0, -1])
    for (const close of screen.getAllByRole('button', { name: /^Close tab / })) expect(close.tabIndex).toBe(-1)
  })

  it('moves to and shows the next or previous tab with → and ←, wrapping around, and the first or last with Home and End', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderTabs()
    act(() => tab('shell').focus())
    await user.keyboard('{ArrowRight}')
    expect(tab(/^npm run dev/)).toHaveFocus()
    expect(onSelect).toHaveBeenLastCalledWith(5)
    await user.keyboard('{ArrowRight}')
    expect(tab('claude')).toHaveFocus()
    expect(onSelect).toHaveBeenLastCalledWith(0)
    await user.keyboard('{ArrowLeft}')
    expect(tab(/^npm run dev/)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(tab('claude')).toHaveFocus()
    await user.keyboard('{End}')
    expect(tab(/^npm run dev/)).toHaveFocus()
    expect(onSelect).toHaveBeenCalledTimes(5)
  })

  it('scrolls the active tab into view when the tabs overflow', () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      const props = {
        onSelect: () => {},
        onClose: () => {},
        onNew: () => {},
        onRestartClaude: () => {},
        onCopyTranscript: () => {},
        onSaveTranscript: () => {},
        panelOpen: false,
        onTogglePanel: () => {},
      }
      const { rerender } = render(<TabBar tabs={tabs} {...props} />)
      expect(scrolled.at(-1)).toBe(tab('shell'))
      rerender(<TabBar tabs={tabs.map((t) => ({ ...t, active: t.index === 5 }))} {...props} />)
      expect(scrolled.at(-1)).toBe(tab(/^npm run dev/))
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('closes a tab on a middle click', () => {
    const { onClose, onSelect } = renderTabs()
    expect(fireEvent.mouseDown(tab('claude'), { button: 1 })).toBe(false) // no autoscroll or paste
    fireEvent(tab('claude'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(onClose).toHaveBeenCalledWith(0)
    fireEvent(tab('shell'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows each full tab name in its tooltip, and the close shortcut on the active tab', () => {
    renderTabs()
    expect(tab(/^npm run dev/)).toHaveAttribute('title', 'npm run dev -- --host 0.0.0.0 --port 5173')
    expect(screen.getByRole('button', { name: 'Close tab shell' })).toHaveAttribute('title', 'Close tab (Ctrl+Shift+W)')
    expect(screen.getByRole('button', { name: 'Close tab claude' })).toHaveAttribute('title', 'Close tab')
  })
})
