import { act, cleanup, render, screen, within } from '@testing-library/react'
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

describe('Home recent tasks, for screen readers', () => {
  it("says each task's session state, which the dot alone shows", () => {
    const state = appState(theme('Client', [repo('api', [task('fix'), task('docs'), task('ship')])]))
    renderHome(state, { running: ['fix', 'docs'], missing: [], activity: { fix: 'waiting', docs: 'busy' } })
    const recent = within(screen.getByRole('list'))
    expect(recent.getByRole('button', { name: 'Open fix (Client › api), waiting for you' })).toBeInTheDocument()
    expect(recent.getByRole('button', { name: 'Open docs (Client › api), working' })).toBeInTheDocument()
    expect(recent.getByRole('button', { name: 'Open ship (Client › api)' })).toBeInTheDocument()
  })
})

describe('Home tip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const tips = homeTips()
  const tipText = (): HTMLElement => document.querySelector('.home-tip-text') as HTMLElement
  /** Home goes on with the tips where it left off: the tip `k` steps after the one shown first in this test. */
  let first = 0
  const tip = (k: number): string => tips[(first + k) % tips.length]
  const start = (): void => {
    renderHome(appState(theme('Client', [])))
    first = tips.indexOf(tipText().textContent ?? '')
    expect(first).not.toBe(-1)
  }
  const wait = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it('changes on its own without a screen reader announcing each one, and pauses while hovered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    start()
    expect(tipText()).toHaveAttribute('aria-live', 'off')
    await wait(TIP_ROTATE_MS)
    expect(tipText()).toHaveTextContent(tip(1))

    await user.hover(tipText())
    await wait(TIP_ROTATE_MS * 3)
    expect(tipText()).toHaveTextContent(tip(1)) // being read: it stays
    await user.unhover(tipText())
    await wait(TIP_ROTATE_MS)
    expect(tipText()).toHaveTextContent(tip(2))
  })

  it('announces the tip "Next tip" shows, and holds it while the button has the focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    start()
    const next = screen.getByRole('button', { name: 'Next tip' })
    act(() => next.focus())
    expect(tipText()).toHaveAttribute('aria-live', 'polite')
    await user.keyboard('{Enter}')
    expect(tipText()).toHaveTextContent(tip(1))
    await wait(TIP_ROTATE_MS * 3)
    expect(tipText()).toHaveTextContent(tip(1))
    act(() => next.blur())
    expect(tipText()).toHaveAttribute('aria-live', 'off')
    await wait(TIP_ROTATE_MS)
    expect(tipText()).toHaveTextContent(tip(2))
  })

  it('goes on with the next tip when Home opens again, rather than the first', async () => {
    const user = userEvent.setup()
    start()
    await user.click(screen.getByRole('button', { name: 'Next tip' }))
    expect(tipText()).toHaveTextContent(tip(1))
    cleanup()
    renderHome(appState(theme('Client', [])))
    expect(tipText()).toHaveTextContent(tip(2))
  })

  it('goes on after the tip shown last, even from an earlier run of the app', async () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
    })
    try {
      data.set('me-manager.homeTip', '3')
      renderHome(appState(theme('Client', [])))
      expect(tipText()).toHaveTextContent(tips[4])
      await userEvent.setup().click(screen.getByRole('button', { name: 'Next tip' }))
      expect(data.get('me-manager.homeTip')).toBe('5')
      cleanup()
      // A stored value from elsewhere, or none at all, starts with the first tip.
      for (const stored of ['nonsense', '-4', '1.5', undefined]) {
        if (stored === undefined) data.clear()
        else data.set('me-manager.homeTip', stored)
        renderHome(appState(theme('Client', [])))
        expect(tipText()).toHaveTextContent(tips[0])
        cleanup()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('holds still while the window is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let hidden = false
    const spy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    try {
      start()
      hidden = true
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
      await wait(TIP_ROTATE_MS * 3)
      expect(tipText()).toHaveTextContent(tip(0))
      hidden = false
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
      await wait(TIP_ROTATE_MS)
      expect(tipText()).not.toHaveTextContent(tip(0))
    } finally {
      spy.mockRestore()
    }
  })
})
