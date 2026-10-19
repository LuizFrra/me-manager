import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { SettingsDialog } from './SettingsDialog'

describe('SettingsDialog: Remote Control and permissions', () => {
  it('shows both options on by default, with a warning while permissions are skipped', () => {
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: /Remote Control/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Skip permission prompts/ })).toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent(/without asking/)
  })

  it('hides the warning when permissions are not skipped', () => {
    render(
      <SettingsDialog settings={{ ...DEFAULT_SETTINGS, skipPermissions: false }} onSave={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('saves the options when they are turned off', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('checkbox', { name: /Remote Control/ }))
    await user.click(screen.getByRole('checkbox', { name: /Skip permission prompts/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ remoteControl: false, skipPermissions: false }))
  })
})

describe('SettingsDialog: update strategy', () => {
  it('shows rebase by default and saves merge', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={onSave} onCancel={vi.fn()} />)
    const group = screen.getByRole('group', { name: 'Update from base' })
    expect(screen.getByRole('radio', { name: /^Rebase/ })).toBeChecked()
    expect(group).toHaveAccessibleDescription(/a conflict is undone and reported/)
    await user.click(screen.getByRole('radio', { name: /^Merge/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ updateStrategy: 'merge' }))
  })
})

describe('SettingsDialog: claude arguments with a line break', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    skipPermissions: false,
    claudeArgs: ['--append-system-prompt', 'Be brief.\nAnswer in English.', '--model', 'opus'],
  }
  const field = (): HTMLElement => screen.getByLabelText('Extra claude arguments')

  it('warns that the field cannot show it, and saves the arguments untouched when the field was not edited', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={settings} onSave={onSave} onCancel={vi.fn()} />)
    expect(field()).toHaveAccessibleDescription(/Edit settings\.json to change this argument/)
    await user.click(screen.getByRole('checkbox', { name: /Desktop notifications/ })) // another field
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ claudeArgs: settings.claudeArgs }))
  })

  it('saves what was typed once the field is edited', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={settings} onSave={onSave} onCancel={vi.fn()} />)
    await user.clear(field())
    await user.type(field(), '--model sonnet')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ claudeArgs: ['--model', 'sonnet'] }))
  })

  it('shows no warning for ordinary arguments', () => {
    render(
      <SettingsDialog
        settings={{ ...settings, claudeArgs: ['--model', 'opus'] }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByText(/settings\.json/)).not.toBeInTheDocument()
  })
})
