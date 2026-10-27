import { act, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { App, USAGE_POLL_MS } from './App'
import { createMockApi } from './api/mockApi'

vi.mock('./components/TerminalView', () => ({ TerminalView: () => <div data-testid="terminal" /> }))
// Counts the sidebar's renders.
const sidebar = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./components/Sidebar', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/Sidebar')>()
  return {
    ...real,
    Sidebar: (props: Parameters<typeof real.Sidebar>[0]) => {
      sidebar.renders++
      return real.Sidebar(props)
    },
  }
})

afterEach(() => vi.useRealTimers())

it('leaves the sidebar alone when a poll changes only what it does not show (the usage)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const api = createMockApi()
  const theme = (await api.createTheme('Work')).themes[0]
  const repo = (await api.addRepo(theme.id, '/code/api')).themes[0].items[0]
  const task = (await api.createTask(theme.id, repo.id, 'fix')).themes[0].items[0]
  if (task.kind !== 'repo') throw new Error('not a repo')
  await api.saveUiState({
    version: 1,
    collapsed: [],
    panels: {},
    selected: { themeId: theme.id, itemId: repo.id, taskId: task.tasks[0].id },
  })
  let cost = 0
  const usageOf = api.getUsage
  api.getUsage = async (target) => {
    const usage = await usageOf(target)
    cost += 1
    return { ...usage, all: { ...usage.all, cost }, today: { ...usage.today, cost } }
  }
  let commits = 0
  render(
    <Profiler id="app" onRender={() => commits++}>
      <App api={api} />
    </Profiler>,
  )
  await screen.findByTestId('terminal')
  await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS))
  const before = { commits, sidebar: sidebar.renders, cost }
  await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3))
  expect(cost).toBeGreaterThan(before.cost) // read again, with new numbers
  expect(commits).toBeGreaterThan(before.commits) // shown
  expect(sidebar.renders).toBe(before.sidebar)
})
