import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { budgetStatus } from '../../../shared/budget'
import type { BudgetReport, MeManagerApi, UsageReport } from '../../../shared/types'
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
}

function renderView(budgets: BudgetReport): void {
  const api: Pick<MeManagerApi, 'getUsageReport' | 'getBudgets'> = {
    getUsageReport: async () => report,
    getBudgets: async () => budgets,
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
    const api: Pick<MeManagerApi, 'getUsageReport' | 'getBudgets'> = {
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
