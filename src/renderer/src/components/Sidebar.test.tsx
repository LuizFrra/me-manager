import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveStatus, TaskGitStatus } from '../../../shared/types'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { Sidebar, type SidebarProps } from './Sidebar'

const state = appState(theme('Client', [repo('api', [task('fix'), task('docs')]), folder('notes')]))

function renderSidebar(patch: Partial<SidebarProps> = {}): void {
  const status: LiveStatus = { running: [], missing: [] }
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
      onRemoveTheme={vi.fn()}
      onAddRepo={vi.fn()}
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
