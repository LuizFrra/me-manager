import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { budgetStatus } from '../../../shared/budget'
import type { BudgetReport, MeManagerApi, UsageFolder, UsageReport } from '../../../shared/types'
import { emptyUsageSummary } from '../../../shared/usage'
import { UsageView } from './UsageView'

const report: UsageReport = {
  generatedAt: '2026-10-19T12:00:00.000Z',
  total: emptyUsageSummary(),
  themes: [
    {
      themeId: 't',
      name: 'Client X',
      usage: emptyUsageSummary(),
      targets: (['fix', 'docs', 'wip'] as const).map((id) => ({
        target: { themeId: 't', itemId: 'r', taskId: id },
        kind: 'task' as const,
        label: `my-api › ${id}`,
        path: `/wt/${id}`,
        usage: emptyUsageSummary(),
      })),
    },
  ],
  profiles: [],
}

const defaultFolder: UsageFolder = { profileId: 'default', name: 'Default', folder: '/home/u/.claude/projects' }

function renderView(budgets: BudgetReport, usage: UsageReport = report, folders = [defaultFolder]): void {
  const api: Pick<MeManagerApi, 'getUsageReport' | 'getBudgets' | 'getUsageFolders'> = {
    getUsageReport: async () => usage,
    getBudgets: async () => budgets,
    getUsageFolders: async () => folders,
  }
  render(<UsageView api={api} onClose={vi.fn()} onOpenTarget={vi.fn()} onOpenSettings={vi.fn()} />)
}

describe('UsageView budgets', () => {
  it("shows today's and each task's budget as progress bars, the closest to its limit first", async () => {
    renderView({
      daily: budgetStatus(4.1, 5),
      tasks: { fix: budgetStatus(6, 5)!, docs: budgetStatus(1, 10)!, wip: budgetStatus(3.5, 5)! },
    })
    const section = await screen.findByRole('region', { name: 'Budgets' })
    const bars = within(section).getAllByRole('progressbar')
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Today, all tasks and folders',
      'Client X › my-api › fix',
      'Client X › my-api › wip',
      'Client X › my-api › docs',
    ])
    expect(bars[0]).toHaveAttribute('aria-valuenow', '82')
    expect(bars[0]).toHaveAttribute('aria-valuetext', '$4.10 of $5.00 daily budget (82%)')
    expect(bars[0]).toHaveClass('budget-warn')
    // Over: the bar is full, the text says by how much.
    expect(bars[1]).toHaveAttribute('aria-valuenow', '100')
    expect(bars[1]).toHaveAttribute('aria-valuetext', '$6.00 of $5.00 task budget (120%)')
    expect(bars[1]).toHaveClass('budget-over')
    expect(bars[3]).toHaveClass('budget-ok')
    expect(section).toHaveTextContent('$6.00 of $5.00 task budget')
  })

  it('says how to set budgets when there are none', async () => {
    renderView({ daily: null, tasks: {} })
    const section = await screen.findByRole('region', { name: 'Budgets' })
    expect(within(section).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(section).toHaveTextContent('No budgets set.')
    expect(within(section).getByRole('button', { name: 'Set budgets in Settings' })).toBeInTheDocument()
  })
})

describe('UsageView errors', () => {
  it("shows why the usage can't be read without the IPC wrapper's prefix", async () => {
    const api: Pick<MeManagerApi, 'getUsageReport' | 'getBudgets' | 'getUsageFolders'> = {
      getUsageFolders: async () => [defaultFolder],
      getUsageReport: async () => {
        throw new Error(
          "Error invoking remote method 'api:getUsageReport': Error: EACCES: permission denied, scandir '/home/u/.claude/projects'",
        )
      },
      getBudgets: async () => ({ daily: null, tasks: {} }),
    }
    render(<UsageView api={api} onClose={vi.fn()} onOpenTarget={vi.fn()} onOpenSettings={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Could not read the usage: EACCES: permission denied, scandir '/home/u/.claude/projects'",
    )
  })
})

describe('UsageView periods', () => {
  it('names the rolling week as such, like the header badge, and shows its totals', async () => {
    const user = userEvent.setup()
    const total = emptyUsageSummary()
    total.week = { ...total.week, cost: 1.71, messages: 3 }
    total.month = { ...total.month, cost: 5, messages: 9 }
    renderView({ daily: null, tasks: {} }, { ...report, total })
    const periods = within(await screen.findByRole('group', { name: 'Period' })).getAllByRole('button')
    expect(periods.map((b) => b.textContent)).toEqual(['Today', 'Last 7 days', 'This month', 'All time'])
    expect(periods[1]).toHaveAttribute('title', 'The last 7 days, today included')
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('$5.00')
    await user.click(periods[1])
    expect(periods[1]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('$1.71')
  })
})

describe('UsageView footnote', () => {
  it('names the folder the transcripts are read from (CLAUDE_CONFIG_DIR when set)', async () => {
    renderView({ daily: null, tasks: {} }, report, [{ ...defaultFolder, folder: '/custom/claude/projects' }])
    expect(await screen.findByText('/custom/claude/projects')).toBeInTheDocument()
    expect(screen.queryByText(/~\/\.claude/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Default/)).not.toBeInTheDocument()
  })

  it('names every Claude profile’s folder, with the profile, when there are several', async () => {
    renderView({ daily: null, tasks: {} }, report, [
      defaultFolder,
      { profileId: 'w', name: 'Work', folder: '/srv/claude-work/projects' },
    ])
    const note = (await screen.findByText('/srv/claude-work/projects')).closest('p')!
    expect(note).toHaveTextContent(
      'in /home/u/.claude/projects (Default) and /srv/claude-work/projects (Work), which it prunes',
    )
  })
})
