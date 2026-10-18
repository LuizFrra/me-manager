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
