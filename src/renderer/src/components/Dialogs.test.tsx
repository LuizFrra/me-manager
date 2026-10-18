import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmRemoveDialog, RemoveTaskDialog } from './Dialogs'

const work = { uncommittedFiles: ['src/login.ts'], unpushedCommits: [] }

describe('RemoveTaskDialog', () => {
  it('confirms only once when "Remove anyway" is double-clicked', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)))
    render(<RemoveTaskDialog taskName="t" work={work} onConfirm={onConfirm} onCancel={() => {}} />)
    await user.dblClick(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    finish()
  })

  it('disables both buttons while removing, and re-enables them if the dialog stays open', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)))
    render(<RemoveTaskDialog taskName="t" work={work} onConfirm={onConfirm} onCancel={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled()
    finish()
    expect(await screen.findByRole('button', { name: 'Remove anyway' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('shows the warning when the check could not run fully', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn(async () => {})
    render(
      <RemoveTaskDialog
        taskName="t"
        work={{ uncommittedFiles: [], unpushedCommits: [], warning: 'repo missing' }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('repo missing')
    await user.click(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })
})

describe('ConfirmRemoveDialog', () => {
  it('confirms once on a double click, with Remove focused, and is busy meanwhile', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)))
    render(<ConfirmRemoveDialog kind="theme" name="Client X" onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The theme is removed from me-manager.')
    await user.dblClick(screen.getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    finish()
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeEnabled()
  })

  it('describes the theme an item leaves, and says the files stay', () => {
    render(
      <ConfirmRemoveDialog
        kind="repo"
        name="my-api"
        themeName="Client X"
        path="/code/my-api"
        onConfirm={async () => {}}
        onCancel={() => {}}
      />,
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Remove repository my-api' })
    expect(dialog).toHaveAccessibleDescription(/The repository is removed from Client X\..*not touched\./)
  })
})
