import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaskHeader, type RunControlsProps } from './TaskHeader'

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

describe('TaskHeader session state', () => {
  it.each([
    ['busy', 'Working'],
    ['waiting', 'Waiting for you'],
    ['idle', 'Idle'],
    ['none', 'No session'],
  ] as const)('shows %s as "%s"', (session, label) => {
    render(<TaskHeader {...base} session={session} />)
    const pill = screen.getByLabelText(`Session: ${label}`)
    expect(pill).toHaveTextContent(label)
    expect(pill).toHaveClass('session-state', session)
  })
})

describe('TaskHeader run controls', () => {
  const run = (over: Partial<RunControlsProps> = {}): RunControlsProps => ({
    command: 'npm run dev',
    state: 'none',
    onRun: vi.fn(),
    onRestart: vi.fn(),
    onStop: vi.fn(),
    onEdit: vi.fn(),
    ...over,
  })
  const group = (): HTMLElement => screen.getByRole('group', { name: 'Run' })

  it('offers to set a command when there is none', async () => {
    const user = userEvent.setup()
    const props = run({ command: undefined })
    render(<TaskHeader {...base} run={props} />)
    expect(within(group()).getAllByRole('button')).toHaveLength(1)
    await user.click(within(group()).getByRole('button', { name: 'Set run command…' }))
    expect(props.onEdit).toHaveBeenCalledTimes(1)
  })

  it('runs the command when nothing runs yet, without a state or Restart and Stop', async () => {
    const user = userEvent.setup()
    const props = run()
    render(<TaskHeader {...base} run={props} />)
    const button = within(group()).getByRole('button', { name: 'Run npm run dev' })
    expect(button).toHaveAttribute('title', 'Run “npm run dev” in a “run” tab')
    await user.click(button)
    expect(props.onRun).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText(/^Run: /)).not.toBeInTheDocument()
    expect(within(group()).queryByRole('button', { name: 'Restart run' })).not.toBeInTheDocument()
    expect(within(group()).queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
    await user.click(within(group()).getByRole('button', { name: 'Edit run command…' }))
    expect(props.onEdit).toHaveBeenCalledTimes(1)
  })

  it('shows a running command, with Restart and Stop', async () => {
    const user = userEvent.setup()
    const props = run({ state: 'running' })
    render(<TaskHeader {...base} run={props} />)
    expect(screen.getByLabelText('Run: running')).toHaveClass('run-state', 'running')
    expect(within(group()).getByRole('button', { name: 'Run npm run dev' })).toHaveAttribute(
      'title',
      'Show the “run” tab',
    )
    await user.click(within(group()).getByRole('button', { name: 'Restart run' }))
    await user.click(within(group()).getByRole('button', { name: 'Stop run' }))
    expect(props.onRestart).toHaveBeenCalledTimes(1)
    expect(props.onStop).toHaveBeenCalledTimes(1)
  })

  it('shows a stopped command, with Restart only', () => {
    render(<TaskHeader {...base} run={run({ state: 'stopped' })} />)
    expect(screen.getByLabelText('Run: stopped')).toHaveClass('run-state', 'stopped')
    expect(within(group()).getByRole('button', { name: 'Restart run' })).toBeInTheDocument()
    expect(within(group()).queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })

  it('is absent without run props', () => {
    render(<TaskHeader {...base} />)
    expect(screen.queryByRole('group', { name: 'Run' })).not.toBeInTheDocument()
  })
})
