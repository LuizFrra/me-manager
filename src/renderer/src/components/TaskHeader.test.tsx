import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskHeader } from './TaskHeader'

const base = {
  title: 'my-api › fix',
  subtitle: 'branch: claude/client-x/fix',
  copies: [],
  onCopy: vi.fn(),
  onOpenInEditor: vi.fn(),
  onRevealInFileManager: vi.fn(),
}

describe('TaskHeader session badges', () => {
  it('shows the Remote and skipped-permissions badges when enabled', () => {
    render(<TaskHeader {...base} sessionFlags={{ remoteControl: true, skipPermissions: true }} />)
    expect(screen.getByText('Remote')).toBeInTheDocument()
    expect(screen.getByText('⚠ permissions skipped')).toBeInTheDocument()
  })

  it('shows no badges when both are off', () => {
    render(<TaskHeader {...base} sessionFlags={{ remoteControl: false, skipPermissions: false }} />)
    expect(screen.queryByText('Remote')).not.toBeInTheDocument()
    expect(screen.queryByText('⚠ permissions skipped')).not.toBeInTheDocument()
  })
})

describe('TaskHeader git line', () => {
  const git = {
    ahead: 3,
    behind: 1,
    uncommitted: 2,
    branch: 'claude/client-x/fix',
    lastCommit: { sha: 'abc1234', subject: 'Fix the login redirect', relativeDate: '2 hours ago' },
  }

  it('shows the branch, ahead/behind, uncommitted files and the last commit', () => {
    render(<TaskHeader {...base} git={git} baseRef="origin/main" />)
    const line = screen.getByLabelText('Git status')
    expect(line).toHaveTextContent('claude/client-x/fix')
    expect(line).toHaveTextContent('↑3 ↓1 vs origin/main')
    expect(screen.getByTitle('3 ahead, 1 behind origin/main')).toBeInTheDocument()
    expect(screen.getByTitle('2 uncommitted files')).toHaveTextContent('●2 uncommitted')
    expect(line).toHaveTextContent('abc1234 Fix the login redirect · 2 hours ago')
  })

  it('warns when the base ref is missing', () => {
    render(<TaskHeader {...base} git={{ ...git, ahead: 0, behind: 0, baseMissing: true }} baseRef="origin/gone" />)
    expect(screen.getByLabelText('Git status')).toHaveTextContent('⚠ Base origin/gone not found')
    expect(screen.queryByText(/vs origin/)).not.toBeInTheDocument()
  })

  it('is absent until the status has loaded', () => {
    render(<TaskHeader {...base} baseRef="origin/main" />)
    expect(screen.queryByLabelText('Git status')).not.toBeInTheDocument()
  })
})
