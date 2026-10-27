import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PrereqScreen } from './PrereqScreen'

const result = { ok: false, missing: [{ tool: 'tmux', hint: 'sudo apt install tmux' }] }

describe('PrereqScreen', () => {
  it('copies an install hint', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<PrereqScreen result={result} onRetry={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the tmux hint' }))
    expect(writeText).toHaveBeenCalledWith('sudo apt install tmux')
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('says it is checking again until the check is done', async () => {
    let done = (): void => {}
    render(<PrereqScreen result={result} onRetry={() => new Promise<void>((r) => (done = r))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    done()
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled()
  })
})
