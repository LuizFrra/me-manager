import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  ArchiveTaskDialog,
  ChooseThemeDialog,
  CommitDialog,
  ConfirmRemoveDialog,
  ConflictDialog,
  DeleteArchivedTaskDialog,
  NameDialog,
  NotesDialog,
  RemoveTaskDialog,
} from './Dialogs'

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

describe('ArchiveTaskDialog', () => {
  it('lists the files that would be discarded and archives anyway only on the explicit button, once', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const onCancel = vi.fn()
    render(
      <ArchiveTaskDialog
        taskName="fix"
        work={{ uncommittedFiles: ['src/login.ts', 'notes.txt'], unpushedCommits: ['abc1234 wip'] }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Archive fix' })
    expect(dialog).toHaveTextContent('2 uncommitted or untracked files')
    expect(dialog).toHaveTextContent('src/login.ts')
    expect(dialog).toHaveTextContent('notes.txt')
    expect(dialog).toHaveTextContent('Commit or discard the changes first')
    expect(dialog).not.toHaveTextContent('abc1234') // commits stay on the branch
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.dblClick(screen.getByRole('button', { name: 'Archive anyway (discards changes)' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Archiving…' })).toBeDisabled()
    finish()
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('shows the warning when the worktree could not be checked, and closes with Esc', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(
      <ArchiveTaskDialog
        taskName="fix"
        work={{ uncommittedFiles: [], unpushedCommits: [], warning: 'git status failed' }}
        onConfirm={vi.fn(async () => {})}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('git status failed')
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('DeleteArchivedTaskDialog', () => {
  it('names the branch it deletes and warns about commits not on the base or pushed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn(async () => {})
    render(
      <DeleteArchivedTaskDialog
        taskName="fix"
        branch="claude/client-x/fix"
        baseRef="origin/main"
        work={{ uncommittedFiles: [], unpushedCommits: ['abc1234 wip', 'def5678 more'] }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Delete archived task fix' })
    expect(dialog).toHaveTextContent('claude/client-x/fix')
    expect(screen.getByRole('alert')).toHaveTextContent('2 commits that are not on origin/main or pushed')
    expect(dialog).toHaveTextContent('abc1234 wip')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Delete task and branch' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('says plainly when every commit is safe elsewhere', () => {
    render(
      <DeleteArchivedTaskDialog
        taskName="fix"
        branch="claude/client-x/fix"
        baseRef="origin/main"
        work={{ uncommittedFiles: [], unpushedCommits: [] }}
        onConfirm={vi.fn(async () => {})}
        onCancel={() => {}}
      />,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Every commit on it is on origin/main or pushed.')
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

describe('dialogs give focus back when they close', () => {
  /** A button that opens the dialog; the dialog gets a `close` callback. */
  function Opener({ dialog }: { dialog: (close: () => void) => React.ReactNode }): React.JSX.Element {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && dialog(() => setOpen(false))}
      </>
    )
  }
  const noChanges = async (): Promise<{ files: [] }> => ({ files: [] })

  it.each([
    [
      'Name',
      (close: () => void) => <NameDialog title="New theme" placeholder="" onSubmit={async () => {}} onCancel={close} />,
    ],
    ['Notes', (close: () => void) => <NotesDialog taskName="t" initial="" onSave={async () => {}} onCancel={close} />],
    [
      'Commit',
      (close: () => void) => (
        <CommitDialog
          taskName="t"
          branch="b"
          loadChanges={noChanges as never}
          onCommit={async () => {}}
          onCancel={close}
        />
      ),
    ],
    [
      'Confirm',
      (close: () => void) => (
        <ConfirmRemoveDialog kind="theme" name="Client X" onConfirm={async () => {}} onCancel={close} />
      ),
    ],
    [
      'Conflicts',
      (close: () => void) => (
        <ConflictDialog
          branch="b"
          baseRef="main"
          strategy="rebase"
          files={['a.ts']}
          onAskClaude={async () => {}}
          onClose={close}
        />
      ),
    ],
    [
      'ChooseTheme',
      (close: () => void) => (
        <ChooseThemeDialog title="Pick" themes={[{ id: '1', name: 'One' }]} onChoose={close} onCancel={close} />
      ),
    ],
  ])('%s: Esc closes it and focus returns to what had it before', async (_name, dialog) => {
    const user = userEvent.setup()
    render(<Opener dialog={dialog} />)
    const opener = screen.getByRole('button', { name: 'Open' })
    await user.click(opener)
    expect(opener).not.toHaveFocus() // the dialog took it
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
})
