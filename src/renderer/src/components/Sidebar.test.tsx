import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LiveStatus, TaskGitStatus } from '../../../shared/types'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { Sidebar, type SidebarProps } from './Sidebar'

const state = appState(theme('Client', [repo('api', [task('fix'), task('docs')]), folder('notes')]))

function renderSidebar(patch: Partial<SidebarProps> = {}): void {
  const status: LiveStatus = { running: [], missing: [], activity: {} }
  render(
    <Sidebar
      state={state}
      status={status}
      selected={null}
      collapsed={new Set()}
      onToggleCollapsed={vi.fn()}
      filter=""
      onFilterChange={vi.fn()}
      onSelect={vi.fn()}
      onAddTheme={vi.fn()}
      onRenameTheme={vi.fn()}
      onCustomizeTheme={vi.fn()}
      onRemoveTheme={vi.fn()}
      onAddRepo={vi.fn()}
      onCloneRepo={vi.fn()}
      onAddFolder={vi.fn()}
      onRemoveItem={vi.fn()}
      onAddTask={vi.fn()}
      onRenameTask={vi.fn()}
      onRemoveTask={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenUsage={vi.fn()}
      {...patch}
    />,
  )
}

const git = (patch: Partial<TaskGitStatus>): TaskGitStatus => ({
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  branch: 'b/fix',
  ...patch,
})

describe('Sidebar git badges', () => {
  it('shows ahead, behind and uncommitted badges with tooltips', () => {
    renderSidebar({ gitStatus: { fix: git({ ahead: 3, behind: 1, uncommitted: 2 }) } })
    expect(screen.getByTitle('3 commits ahead of origin/main')).toHaveTextContent('↑3')
    expect(screen.getByTitle('1 commit behind origin/main')).toHaveTextContent('↓1')
    expect(screen.getByTitle('2 uncommitted files')).toHaveTextContent('●2')
    expect(
      screen.getByRole('img', {
        name: '3 commits ahead of origin/main, 1 commit behind origin/main, 2 uncommitted files',
      }),
    ).toBeInTheDocument()
  })

  it('keeps the task button name free of the badges', () => {
    renderSidebar({ gitStatus: { fix: git({ ahead: 3 }) } })
    expect(screen.getByRole('button', { name: '○ fix' })).toBeInTheDocument()
  })

  it('shows only the non-zero counts, and nothing for a clean task or one without a status', () => {
    renderSidebar({ gitStatus: { fix: git({ uncommitted: 1 }), docs: git({}) } })
    expect(screen.getByTitle('1 uncommitted file')).toBeInTheDocument()
    expect(screen.queryByText(/↑|↓/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })
})

describe('Sidebar status dot', () => {
  /** The dot of a task or folder row: its button is named "<dot> [📁 ]<name>". */
  const dotOf = (name: string): HTMLElement => {
    const dot = screen.getByRole('button', { name: new RegExp(`^\\S (📁 )?${name}$`, 'u') }).querySelector('.dot')
    if (!(dot instanceof HTMLElement)) throw new Error('no dot')
    return dot
  }

  it('shows Claude busy, waiting and idle, and a session without its claude window', () => {
    renderSidebar({
      state: appState(
        theme('Client', [repo('api', [task('fix'), task('docs'), task('ship'), task('shell')]), folder('notes')]),
      ),
      status: {
        running: ['fix', 'docs', 'ship', 'shell'],
        missing: [],
        activity: { fix: 'busy', docs: 'waiting', ship: 'idle' },
      },
    })
    expect(dotOf('fix')).toHaveClass('dot', 'running', 'busy')
    expect(dotOf('fix')).toHaveAttribute('title', 'Claude is working')
    expect(dotOf('docs')).toHaveClass('running', 'waiting')
    expect(dotOf('docs').title).toMatch(/^Waiting for you/)
    expect(dotOf('ship')).toHaveClass('running', 'idle')
    expect(dotOf('ship')).toHaveAttribute('title', 'Claude is idle')
    expect(dotOf('shell').className).toBe('dot running')
    for (const name of ['fix', 'docs', 'ship', 'shell']) expect(dotOf(name)).toHaveTextContent('●')
  })

  it('keeps ○ for no session and ⚠ for a missing path', () => {
    renderSidebar({ status: { running: ['docs'], missing: ['docs', 'notes'], activity: { docs: 'busy' } } })
    expect(dotOf('fix').className).toBe('dot none')
    expect(dotOf('fix')).toHaveTextContent('○')
    expect(dotOf('docs').className).toBe('dot missing')
    expect(dotOf('docs')).toHaveTextContent('⚠')
    expect(dotOf('notes')).toHaveAttribute('title', 'Path missing')
  })
})

describe('Sidebar theme style', () => {
  it("shows the theme's icon before its name and a colour stripe, keeping the row's name", () => {
    renderSidebar({ state: appState({ ...theme('Client', []), color: 'purple', icon: '🚀' }, theme('Plain', [])) })
    const label = screen.getByRole('button', { name: '▼ Client' })
    expect(label).toHaveTextContent('▼ 🚀Client')
    const row = label.closest('.theme-row') as HTMLElement
    expect(row).toHaveClass('has-color')
    expect(row.style.getPropertyValue('--theme-color')).toBe('#a371f7')
    const plain = screen.getByRole('button', { name: '▼ Plain' }).closest('.theme-row') as HTMLElement
    expect(plain).not.toHaveClass('has-color')
    expect(plain.style.getPropertyValue('--theme-color')).toBe('')
  })

  it('ignores a colour that is not in the palette', () => {
    const odd = { ...theme('Odd', []), color: 'url(x)' as never }
    renderSidebar({ state: appState(odd) })
    const row = screen.getByRole('button', { name: '▼ Odd' }).closest('.theme-row') as HTMLElement
    expect(row.getAttribute('style')).toBeNull()
  })

  it('opens Customize theme from the row', async () => {
    const onCustomizeTheme = vi.fn()
    renderSidebar({ onCustomizeTheme })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Customize theme Client' }))
    expect(onCustomizeTheme).toHaveBeenCalledWith('Client')
  })
})
