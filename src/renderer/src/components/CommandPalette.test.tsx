import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette, MAX_PALETTE_RESULTS, type PaletteCommand } from './CommandPalette'

const command = (label: string): PaletteCommand => ({ id: label, kind: 'action', label })

describe('CommandPalette', () => {
  it('shows at most 50 results', async () => {
    const user = userEvent.setup()
    const commands = Array.from({ length: 80 }, (_, i) => command(`Command ${i}`))
    render(<CommandPalette commands={commands} onRun={vi.fn()} onOpenFile={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getAllByRole('option')).toHaveLength(MAX_PALETTE_RESULTS)
    await user.type(screen.getByRole('combobox'), 'cmd')
    expect(screen.getAllByRole('option')).toHaveLength(MAX_PALETTE_RESULTS)
  })

  it('moves with the arrow keys, wrapping around, and runs the active result on Enter', async () => {
    const user = userEvent.setup()
    const commands = [command('One'), command('Two'), command('Three')]
    const onClose = vi.fn()
    const onRun = vi.fn()
    render(<CommandPalette commands={commands} onRun={onRun} onOpenFile={vi.fn()} onClose={onClose} />)
    const selected = (): string | null =>
      screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent ?? null
    expect(selected()).toContain('One')
    await user.keyboard('{ArrowDown}')
    expect(selected()).toContain('Two')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(selected()).toContain('Three')
    await user.keyboard('{Enter}')
    expect(onClose).toHaveBeenCalled()
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledWith(commands[2])
  })

  it('runs a clicked result and closes on Esc', async () => {
    const user = userEvent.setup()
    const commands = [command('One'), command('Two')]
    const onClose = vi.fn()
    const onRun = vi.fn()
    render(<CommandPalette commands={commands} onRun={onRun} onOpenFile={vi.fn()} onClose={onClose} />)
    await user.click(screen.getByRole('option', { name: 'Two' }))
    expect(onRun).toHaveBeenCalledWith(commands[1])
    onClose.mockClear()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lists files only once the user types, and loads them once', async () => {
    const user = userEvent.setup()
    const loadFiles = vi.fn(async () => ({ paths: ['src/main.ts', 'README.md'], truncated: false }))
    const onOpenFile = vi.fn()
    render(
      <CommandPalette
        commands={[command('New theme')]}
        loadFiles={loadFiles}
        onRun={vi.fn()}
        onOpenFile={onOpenFile}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(loadFiles).toHaveBeenCalledTimes(1))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.type(screen.getByRole('combobox'), 'main')
    await user.click(await screen.findByRole('option', { name: 'src/main.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('src/main.ts')
    expect(loadFiles).toHaveBeenCalledTimes(1)
  })

  it('says when nothing matches and highlights matched characters', async () => {
    const user = userEvent.setup()
    render(
      <CommandPalette
        commands={[command('Toggle files panel')]}
        onRun={vi.fn()}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await user.type(screen.getByRole('combobox'), 'tfp')
    const option = screen.getByRole('option', { name: 'Toggle files panel' })
    expect([...option.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['T', 'f', 'p'])
    await user.type(screen.getByRole('combobox'), 'zzz')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('listbox')).toBeInTheDocument()
  })
})
