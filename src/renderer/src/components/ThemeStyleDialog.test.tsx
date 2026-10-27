import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ThemeStyleDialog } from './ThemeStyleDialog'

describe('ThemeStyleDialog', () => {
  it('takes a single emoji made of many code units, like a family', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<ThemeStyleDialog themeName="Home" initial={{}} onSave={onSave} onCancel={vi.fn()} />)
    const field = screen.getByRole('textbox', { name: 'Emoji' })
    await user.click(field)
    await user.paste('👨‍👩‍👧‍👦')
    expect(field).toHaveValue('👨‍👩‍👧‍👦')
    expect(field).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('Use a single emoji')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ icon: '👨‍👩‍👧‍👦' })
  })

  it('still refuses two emoji', async () => {
    const user = userEvent.setup()
    render(<ThemeStyleDialog themeName="Home" initial={{}} onSave={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('textbox', { name: 'Emoji' }))
    await user.paste('🚀🔥')
    expect(screen.getByText('Use a single emoji')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it("doesn't close on Esc while saving, as Cancel doesn't", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(
      <ThemeStyleDialog themeName="Home" initial={{}} onSave={() => new Promise<void>(() => {})} onCancel={onCancel} />,
    )
    await user.click(screen.getByRole('button', { name: 'Icon 🚀' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await user.click(screen.getByRole('textbox', { name: 'Emoji' }))
    await user.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
