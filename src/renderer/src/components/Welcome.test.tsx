import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, LiveStatus } from '../../../shared/types'
import { homeTips, TIP_ROTATE_MS } from '../lib/onboarding'
import { appState, repo, task, theme } from '../test/fixtures'
import { Home } from './Welcome'

const NO_STATUS: LiveStatus = { running: [], missing: [], activity: {} }

function renderHome(state: AppState, status = NO_STATUS): void {
  render(
    <Home
      state={state}
      status={status}
      onOpen={vi.fn()}
      onCreateTheme={vi.fn()}
      onAddRepo={vi.fn()}
      onCloneRepo={vi.fn()}
      onOpenPalette={vi.fn()}
      onStartTask={vi.fn(async () => true)}
      onMoreTaskOptions={vi.fn()}
      composerFocus={0}
    />,
  )
}

describe('Home recent tasks', () => {
  it('shows the full task name and where it lives in tooltips, as both are cut short when long', () => {
    const name = 'Fix the login redirect loop on expired sessions'
    renderHome(appState(theme('Client', [repo('billing-api', [task(name)])])))
    const recent = within(screen.getByRole('list'))
    expect(recent.getByText(name)).toHaveAttribute('title', name)
    expect(recent.getByText('Client › billing-api')).toHaveAttribute('title', 'Client › billing-api')
  })
})

describe('Home tip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const tips = homeTips()
  const tipText = (): HTMLElement => document.querySelector('.home-tip-text') as HTMLElement
  const wait = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it('changes on its own without a screen reader announcing each one, and pauses while hovered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderHome(appState(theme('Client', [])))
    expect(tipText()).toHaveTextContent(tips[0])
    expect(tipText()).toHaveAttribute('aria-live', 'off')
    await wait(TIP_ROTATE_MS)
    expect(tipText()).toHaveTextContent(tips[1])

    await user.hover(tipText())
    await wait(TIP_ROTATE_MS * 3)
    expect(tipText()).toHaveTextContent(tips[1]) // being read: it stays
    await user.unhover(tipText())
    await wait(TIP_ROTATE_MS)
    expect(tipText()).toHaveTextContent(tips[2])
  })

  it('announces the tip "Next tip" shows, and holds it while the button has the focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderHome(appState(theme('Client', [])))
    const next = screen.getByRole('button', { name: 'Next tip' })
    act(() => next.focus())
    expect(tipText()).toHaveAttribute('aria-live', 'polite')
    await user.keyboard('{Enter}')
    expect(tipText()).toHaveTextContent(tips[1])
    await wait(TIP_ROTATE_MS * 3)
    expect(tipText()).toHaveTextContent(tips[1])
    act(() => next.blur())
    expect(tipText()).toHaveAttribute('aria-live', 'off')
    await wait(TIP_ROTATE_MS)
    expect(tipText()).toHaveTextContent(tips[2])
  })
})
