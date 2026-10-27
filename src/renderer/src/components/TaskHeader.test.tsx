import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { budgetStatus } from '../../../shared/budget'
import type { BudgetStatus, UsageSummary } from '../../../shared/types'
import { emptyUsageSummary } from '../../../shared/usage'
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

describe('TaskHeader actions', () => {
  it('opens the editor directly, and the rest from the More actions menu', async () => {
    const user = userEvent.setup()
    const props = {
      ...base,
      copies: [{ kind: 'branch' as const, label: 'Copy branch name', what: 'branch name', text: 'b' }],
      onCopy: vi.fn(),
      onOpenInEditor: vi.fn(),
      onRevealInFileManager: vi.fn(),
      onEditNotes: vi.fn(),
    }
    render(<TaskHeader {...props} />)
    await user.click(screen.getByRole('button', { name: 'Open in editor' }))
    expect(props.onOpenInEditor).toHaveBeenCalledTimes(1)

    const more = screen.getByRole('button', { name: 'More actions' })
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'More actions' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Reveal in file manager', 'Copy branch name', 'Edit notes'])
    expect(within(menu).getByRole('menuitem', { name: 'Reveal in file manager' })).toHaveFocus()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(props.onCopy).toHaveBeenCalledWith(props.copies[0])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(more).toHaveFocus()

    await user.click(more)
    await user.click(more) // the button toggles its menu
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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
    const button = within(group()).getByRole('button', { name: 'Start npm run dev' })
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
    expect(within(group()).getByRole('button', { name: 'Show run tab' })).toHaveAttribute('title', 'Show the “run” tab')
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

describe('TaskHeader dev-server links', () => {
  const urls = [
    { url: 'http://localhost:5173/', index: 2, tab: 'run' },
    { url: 'http://127.0.0.1:8000/admin/', index: 1, tab: 'shell' },
  ]

  it('shows each URL as a link that opens it in the browser through onOpenUrl', async () => {
    const user = userEvent.setup()
    const onOpenUrl = vi.fn()
    render(<TaskHeader {...base} devUrls={urls} onOpenUrl={onOpenUrl} />)
    const links = within(screen.getByRole('group', { name: 'Dev-server links' })).getAllByRole('link')
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['localhost:5173', 'http://localhost:5173/'],
      ['127.0.0.1:8000/admin/', 'http://127.0.0.1:8000/admin/'],
    ])
    expect(links[0]).toHaveAttribute('title', 'Open http://localhost:5173/ in the browser (printed in the “run” tab)')
    await user.click(links[1])
    expect(onOpenUrl).toHaveBeenCalledWith('http://127.0.0.1:8000/admin/')
  })

  it('shows no links line without URLs', () => {
    render(<TaskHeader {...base} devUrls={[]} onOpenUrl={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Dev-server links' })).not.toBeInTheDocument()
  })
})

describe('TaskHeader usage badge and budget', () => {
  const usageOf = (cost: number): UsageSummary => {
    const s = emptyUsageSummary()
    s.all.cost = cost
    s.all.output = 1000
    return s
  }
  const renderBadge = (cost: number, budget?: BudgetStatus | null): HTMLElement => {
    render(<TaskHeader {...base} usage={usageOf(cost)} onOpenUsage={vi.fn()} budget={budget} />)
    return screen.getByRole('button', { name: /^Claude usage:/ })
  }

  it('looks as usual and says nothing of a budget when the task has none', () => {
    const badge = renderBadge(4.1, null)
    expect(badge).toHaveAccessibleName('Claude usage: $4.10 · 1k tok')
    expect(badge).not.toHaveClass('budget-warn')
    expect(badge).not.toHaveClass('budget-over')
    expect(badge).not.toHaveAccessibleDescription(/budget/)
  })

  it('shows the budget in the tooltip while under 80%, without warning', () => {
    const badge = renderBadge(1, budgetStatus(1, 5))
    expect(badge).toHaveAccessibleDescription(/\$1\.00 of \$5\.00 task budget \(20%\)/)
    expect(badge).not.toHaveClass('budget-warn')
  })

  it('warns from 80%, with the budget in its name and tooltip', () => {
    const badge = renderBadge(4.1, budgetStatus(4.1, 5))
    expect(badge).toHaveClass('budget-warn')
    expect(badge).toHaveAccessibleName('Claude usage: $4.10 · 1k tok, 82% of its budget')
    expect(badge).toHaveAccessibleDescription(/\$4\.10 of \$5\.00 task budget \(82%\)/)
  })

  it('is marked over budget from 100%', () => {
    const badge = renderBadge(6, budgetStatus(6, 5))
    expect(badge).toHaveClass('budget-over')
    expect(badge).not.toHaveClass('budget-warn')
    expect(badge).toHaveAccessibleName('Claude usage: $6.00 · 1k tok, over its budget')
    expect(badge).toHaveAccessibleDescription(/\$6\.00 of \$5\.00 task budget \(120%\)/)
  })
})

describe('TaskHeader long names', () => {
  it('gives the title and path line their full text as a tooltip, as they are cut to one line', () => {
    const title = `my-api › ${'a really long task name '.repeat(6).trim()}`
    const subtitle = `branch: claude/client-x/${'x'.repeat(40)} · /home/u/.me-manager/worktrees/client-x/my-api/${'x'.repeat(40)}`
    render(<TaskHeader {...base} title={title} subtitle={subtitle} />)
    expect(screen.getByText(title)).toHaveAttribute('title', title)
    expect(screen.getByText(subtitle)).toHaveAttribute('title', subtitle)
  })
})

describe('TaskHeader budget', () => {
  it("offers the task's budget in the More actions menu, for tasks only", async () => {
    const user = userEvent.setup()
    const onEditBudget = vi.fn()
    const { unmount } = render(<TaskHeader {...base} onEditNotes={vi.fn()} onEditBudget={onEditBudget} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Set budget…' }))
    expect(onEditBudget).toHaveBeenCalledTimes(1)
    unmount()

    render(<TaskHeader {...base} />) // a folder
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Set budget…' })).not.toBeInTheDocument()
  })
})

describe('TaskHeader Claude account', () => {
  it('chooses the account from the More actions menu, when there are accounts', async () => {
    const user = userEvent.setup()
    const onChooseProfile = vi.fn()
    const { unmount } = render(<TaskHeader {...base} onChooseProfile={onChooseProfile} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Claude account…' }))
    expect(onChooseProfile).toHaveBeenCalledTimes(1)
    unmount()

    render(<TaskHeader {...base} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Claude account…' })).not.toBeInTheDocument()
  })
})

describe('TaskHeader account badge', () => {
  it('names the account, and says when the running Claude is in another one, with Restart Claude', async () => {
    const user = userEvent.setup()
    const onRestart = vi.fn()
    const { rerender } = render(<TaskHeader {...base} account={{ name: 'Work', onRestart }} />)
    expect(screen.getByText('Account: Work')).toBeInTheDocument()
    expect(screen.queryByText(/applies when Claude restarts/)).not.toBeInTheDocument()

    rerender(<TaskHeader {...base} account={{ name: 'Work', running: 'Default', onRestart }} />)
    expect(screen.getByText('(applies when Claude restarts)')).toHaveAttribute(
      'title',
      'Claude is still running in Default',
    )
    await user.click(screen.getByRole('button', { name: 'Restart Claude in Work…' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('shows nothing without an account (a single one)', () => {
    render(<TaskHeader {...base} />)
    expect(screen.queryByText(/^Account:/)).not.toBeInTheDocument()
  })
})
