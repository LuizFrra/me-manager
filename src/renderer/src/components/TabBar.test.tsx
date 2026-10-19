import { fireEvent, render, screen, within } from '@testing-library/react'
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
