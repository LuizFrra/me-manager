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
