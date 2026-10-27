import { act, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { App, GIT_QUIET_POLL_MS, USAGE_POLL_MS } from './App'
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

// Counts each task row's renders, by task id.
const taskRows = vi.hoisted(() => ({ renders: new Map<string, number>() }))
vi.mock('./components/SidebarTaskRow', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/SidebarTaskRow')>()
  return {
    ...real,
    TaskRow: (props: Parameters<typeof real.TaskRow>[0]) => {
      taskRows.renders.set(props.task.id, (taskRows.renders.get(props.task.id) ?? 0) + 1)
      return real.TaskRow(props)
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

it("leaves a task's sidebar row alone when a git poll changes only another task's badges", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const api = createMockApi()
  const theme = (await api.createTheme('Work')).themes[0]
  const repo = (await api.addRepo(theme.id, '/code/api')).themes[0].items[0]
  await api.createTask(theme.id, repo.id, 'quiet')
  const item = (await api.createTask(theme.id, repo.id, 'busy')).themes[0].items[0]
  if (item.kind !== 'repo') throw new Error('not a repo')
  const [quiet, busy] = item.tasks
  await api.saveUiState({
    version: 1,
    collapsed: [],
    panels: {},
    selected: { themeId: theme.id, itemId: repo.id, taskId: busy.id },
  })
  let ahead = 0
  const gitOf = api.getGitStatus
  api.getGitStatus = async (targets) => {
    const out = await gitOf(targets)
    ahead++
    if (out[busy.id]) out[busy.id] = { ...out[busy.id], ahead }
    return out
  }
  render(<App api={api} />)
  await screen.findByTestId('terminal')
  await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS))
  const before = { quiet: taskRows.renders.get(quiet.id), busy: taskRows.renders.get(busy.id) }
  // Past a full read of every task's badges, with the quiet task's the same as before.
  await act(() => vi.advanceTimersByTimeAsync(GIT_QUIET_POLL_MS * 2))
  expect(taskRows.renders.get(busy.id)).toBeGreaterThan(before.busy ?? 0)
  expect(taskRows.renders.get(quiet.id)).toBe(before.quiet)
})
