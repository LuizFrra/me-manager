import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { demoGitStatus } from '../api/mockApi'
import { STATUS_SUBJECT_MAX, truncate } from '../lib/statusText'
import { budgetStatus } from '../../../shared/budget'
import { StatusBar, type StatusBarProps } from './StatusBar'

const bar = (): HTMLElement => screen.getByRole('group', { name: 'Status bar' })

function renderBar(over: Partial<StatusBarProps> = {}): StatusBarProps {
  const props: StatusBarProps = {
    task: {
      branch: 'claude/client-x/fix',
      baseRef: 'origin/main',
      git: { ...demoGitStatus('fix', 'claude/client-x/fix'), ahead: 2, behind: 1, uncommitted: 3 },
    },
    path: '/wt/fix',
    session: 'busy',
    tabs: 2,
    todayCost: 0.42,
    skipPermissions: true,
    onCopyBranch: vi.fn(),
    onOpenChanges: vi.fn(),
    onOpenUsage: vi.fn(),
    ...over,
  }
  render(<StatusBar {...props} />)
  return props
}

describe('StatusBar', () => {
  it("shows a task's branch, standing, changes, last commit, Claude state, tabs, cost and the skip-perms marker", () => {
    renderBar()
    const b = within(bar())
    expect(b.getByRole('button', { name: 'Branch claude/client-x/fix: copy' })).toHaveTextContent('claude/client-x/fix')
    expect(b.getByTitle('2 ahead, 1 behind origin/main')).toHaveTextContent('↑2↓1')
    expect(b.getByRole('button', { name: '3 uncommitted files: show changes' })).toHaveTextContent('3')
    expect(b.getByText('Work on fix')).toBeInTheDocument()
    expect(b.getByText('Claude busy')).toBeInTheDocument()
    expect(b.getByText('2 tabs')).toBeInTheDocument()
    expect(b.getByRole('button', { name: "Today's cost $0.42: show usage" })).toHaveTextContent('$0.42 today')
    expect(b.getByText('⚠ skip-perms')).toBeInTheDocument()
  })

  it('runs the segment actions: copy the branch, open Changes, open the usage view', async () => {
    const user = userEvent.setup()
    const props = renderBar()
    await user.click(screen.getByRole('button', { name: /^Branch / }))
    expect(props.onCopyBranch).toHaveBeenCalledWith('claude/client-x/fix')
    await user.click(screen.getByRole('button', { name: /uncommitted files?: show changes$/ }))
    expect(props.onOpenChanges).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: /^Today's cost/ }))
    expect(props.onOpenUsage).toHaveBeenCalledTimes(1)
  })

  it('shows the task branch until git has answered, and nothing it does not know yet', () => {
    renderBar({
      task: { branch: 'claude/x/y', baseRef: 'origin/main' },
      todayCost: undefined,
      skipPermissions: false,
      session: 'none',
      tabs: 1,
    })
    expect(screen.getByRole('button', { name: 'Branch claude/x/y: copy' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show changes$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Today's cost/ })).not.toBeInTheDocument()
    expect(screen.queryByText('⚠ skip-perms')).not.toBeInTheDocument()
    expect(within(bar()).getByText('No session')).toBeInTheDocument()
    expect(within(bar()).getByText('1 tab')).toBeInTheDocument()
  })

  it('keeps the task branch on a detached HEAD and flags a missing base', () => {
    renderBar({
      task: {
        branch: 'claude/x/y',
        baseRef: 'origin/gone',
        git: { ahead: 0, behind: 0, uncommitted: 0, branch: 'HEAD', baseMissing: true },
      },
    })
    expect(screen.getByRole('button', { name: 'Branch claude/x/y: copy' })).toBeInTheDocument()
    expect(screen.getByText('⚠ no base')).toHaveAttribute('title', expect.stringContaining('origin/gone not found'))
    expect(screen.getByRole('button', { name: '0 uncommitted files: show changes' })).not.toHaveClass('dirty')
  })

  it('cuts a long last commit subject, keeping all of it in the tooltip', () => {
    const subject = 'x'.repeat(STATUS_SUBJECT_MAX + 20)
    renderBar({
      task: {
        branch: 'b',
        baseRef: 'origin/main',
        git: { ...demoGitStatus('b', 'b'), lastCommit: { sha: 'abc1234', subject, relativeDate: 'now' } },
      },
    })
    const shown = screen.getByTitle(new RegExp(`abc1234, now: ${subject}$`))
    expect(shown.textContent).toHaveLength(STATUS_SUBJECT_MAX)
    expect(shown.textContent?.endsWith('…')).toBe(true)
    expect(truncate('short', 10)).toBe('short')
  })

  it("shows only a folder's path and its session state", () => {
    renderBar({ task: undefined, path: '/home/me/notes', session: 'waiting' })
    const b = within(bar())
    expect(b.getByText('/home/me/notes')).toBeInTheDocument()
    expect(b.getByText('Claude waiting')).toBeInTheDocument()
    expect(b.queryAllByRole('button')).toHaveLength(0)
    expect(b.queryByText(/tab/)).not.toBeInTheDocument()
    expect(b.queryByText('⚠ skip-perms')).not.toBeInTheDocument()
  })

  it.each([
    ['running', '▶ running'],
    ['stopped', '■ stopped'],
  ] as const)('shows a %s run tab, which a click shows, for tasks and folders', async (run, text) => {
    const user = userEvent.setup()
    for (const task of [undefined, { branch: 'b', baseRef: 'origin/main' }]) {
      const onShowRun = vi.fn()
      const { unmount } = render(
        <StatusBar
          task={task}
          path="/p"
          session="idle"
          tabs={2}
          skipPermissions={false}
          run={run}
          onShowRun={onShowRun}
          onCopyBranch={vi.fn()}
          onOpenChanges={vi.fn()}
          onOpenUsage={vi.fn()}
        />,
      )
      const button = within(bar()).getByRole('button', { name: `Run tab ${run}: show it` })
      expect(button).toHaveTextContent(text)
      expect(button).toHaveClass('status-run', run)
      await user.click(button)
      expect(onShowRun).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('shows nothing about running without a run tab', () => {
    renderBar({ run: 'none' })
    expect(screen.queryByRole('button', { name: /^Run tab/ })).not.toBeInTheDocument()
  })

  it('shows dev-server URLs as links, for tasks and folders, that open through onOpenUrl', async () => {
    const user = userEvent.setup()
    const devUrls = [
      { url: 'http://localhost:3000/', index: 1, tab: 'run' },
      { url: 'https://localhost:8443/', index: 2, tab: 'shell' },
    ]
    for (const task of [undefined, { branch: 'b', baseRef: 'origin/main' }]) {
      const onOpenUrl = vi.fn()
      const { unmount } = render(
        <StatusBar
          task={task}
          path="/p"
          session="idle"
          tabs={2}
          skipPermissions={false}
          devUrls={devUrls}
          onOpenUrl={onOpenUrl}
          onCopyBranch={vi.fn()}
          onOpenChanges={vi.fn()}
          onOpenUsage={vi.fn()}
        />,
      )
      const links = within(bar()).getAllByRole('link')
      expect(links.map((l) => l.textContent)).toEqual(['localhost:3000', 'https://localhost:8443'])
      await user.click(links[0])
      expect(onOpenUrl).toHaveBeenCalledWith('http://localhost:3000/')
      unmount()
    }
  })
})

describe('StatusBar daily budget', () => {
  const cost = (): HTMLElement => screen.getByRole('button', { name: /^Today's cost/ })

  it("leaves today's cost as it is without a daily budget", () => {
    renderBar({ dailyBudget: null })
    expect(cost()).not.toHaveClass('budget-warn')
    expect(cost()).not.toHaveClass('budget-over')
    expect(cost()).not.toHaveAttribute('title', expect.stringContaining('budget'))
  })

  it('shows the daily budget in the tooltip, and warns from 80% of it', () => {
    renderBar({ todayCost: 0.42, dailyBudget: budgetStatus(4.1, 5) })
    expect(cost()).toHaveClass('budget-warn')
    expect(cost()).toHaveAttribute(
      'title',
      'Estimated cost today at API prices: $0.42 here. $4.10 of $5.00 daily budget (82%), all tasks and folders. Click for the usage view.',
    )
    expect(cost()).toHaveAccessibleName("Today's cost $0.42, 82% of the daily budget: show usage")
    expect(cost()).toHaveTextContent('$0.42 today')
  })

  it('is marked over budget once the day has spent it', () => {
    renderBar({ dailyBudget: budgetStatus(5.5, 5) })
    expect(cost()).toHaveClass('budget-over')
    expect(cost()).toHaveAccessibleName("Today's cost $0.42, over the daily budget: show usage")
    expect(cost()).toHaveAttribute('title', expect.stringContaining('$5.50 of $5.00 daily budget (110%)'))
  })

  it('stays plain under 80%, with the budget in the tooltip', () => {
    renderBar({ dailyBudget: budgetStatus(1, 5) })
    expect(cost()).not.toHaveClass('budget-warn')
    expect(cost()).toHaveAccessibleName("Today's cost $0.42: show usage")
    expect(cost()).toHaveAttribute('title', expect.stringContaining('$1.00 of $5.00 daily budget (20%)'))
  })
})
