import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppState, LiveStatus } from '../../../shared/types'
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
