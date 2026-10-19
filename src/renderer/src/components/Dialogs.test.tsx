import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BranchList, TaskTemplate } from '../../../shared/types'
import {
  ArchiveTaskDialog,
  BudgetDialog,
  ChooseThemeDialog,
  CommitDialog,
  ConfirmRemoveDialog,
  ConflictDialog,
  DeleteArchivedTaskDialog,
  NameDialog,
  NewTaskDialog,
  NotesDialog,
  RemoveTaskDialog,
  RunCommandDialog,
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

describe('BudgetDialog', () => {
  it("sets a task's own budget, naming the default it replaces", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<BudgetDialog taskName="Fix login" initial={null} defaultBudget={5} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Budget for Fix login' })).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Budget' })
    expect(input).toHaveFocus()
    expect(input).toHaveAccessibleDescription(/Leave it empty for the default task budget \(\$5\.00\)/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled() // unchanged
    await user.type(input, '12.5')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(12.5)
  })

  it('removes it when emptied, says when there is no default, and refuses an invalid amount', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<BudgetDialog taskName="Fix login" initial={2.5} defaultBudget={null} onSave={onSave} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Budget' })
    expect(input).toHaveValue('2.50')
    expect(input).toHaveAccessibleDescription(/Leave it empty for no budget/)
    await user.clear(input)
    await user.type(input, 'abc')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount from $0.01 to $100,000')
    expect(input).toBeInvalid()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onSave).toHaveBeenCalledWith(null)
  })

  it('cancels with Escape', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<BudgetDialog taskName="t" initial={null} defaultBudget={null} onSave={vi.fn()} onCancel={onCancel} />)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('RunCommandDialog', () => {
  it('saves a new command, trimmed, saying where it runs', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<RunCommandDialog itemName="my-api" kind="repo" initial="" onSave={onSave} onCancel={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Run command for my-api' })
    expect(dialog).toHaveTextContent('every task of my-api')
    const input = screen.getByRole('textbox', { name: 'Command' })
    expect(input).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled() // unchanged
    await user.type(input, '  npm run dev ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('npm run dev')
  })

  it("edits a folder's command, and removes it when emptied", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<RunCommandDialog itemName="site" kind="folder" initial="hugo server" onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('in the folder')
    const input = screen.getByRole('textbox', { name: 'Command' })
    expect(input).toHaveValue('hugo server')
    await user.clear(input)
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onSave).toHaveBeenCalledWith('')
  })

  it('refuses an over-long command before saving', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<RunCommandDialog itemName="api" kind="repo" initial="" onSave={onSave} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Command' })
    // Typing it would be slow: paste it.
    await user.click(input)
    await user.paste('x'.repeat(1001))
    expect(screen.getByRole('alert')).toHaveTextContent('The run command is limited to 1,000 characters')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
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
      'RunCommand',
      (close: () => void) => (
        <RunCommandDialog itemName="api" kind="repo" initial="" onSave={async () => {}} onCancel={close} />
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

describe('NewTaskDialog templates', () => {
  const LIST: BranchList = { default: 'origin/main', branches: ['origin/main', 'origin/develop', 'main'] }
  const REVIEW: TaskTemplate = {
    name: 'Review',
    taskName: 'review-{n}',
    base: 'origin/develop',
    prompt: 'Review the diff',
  }
  const PROMPT_ONLY: TaskTemplate = { name: 'Explain', prompt: 'Explain this repo' }
  const name = (): HTMLElement => screen.getByRole('textbox', { name: 'Name' })
  const base = (): HTMLElement => screen.getByRole('combobox', { name: 'Base branch' })
  const prompt = (): HTMLElement => screen.getByRole('textbox', { name: 'Initial prompt (optional)' })
  const template = (): HTMLElement => screen.getByRole('combobox', { name: 'Template' })

  const renderDialog = (props: Partial<React.ComponentProps<typeof NewTaskDialog>> = {}): ReturnType<typeof vi.fn> => {
    const onSubmit = vi.fn(async () => {})
    render(
      <NewTaskDialog
        repoName="my-api"
        loadBranches={async () => LIST}
        templates={[REVIEW, PROMPT_ONLY]}
        taskNames={['review-1', 'Review-4']}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        {...props}
      />,
    )
    return onSubmit
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers no Template choice when there are no templates', async () => {
    renderDialog({ templates: [] })
    await waitFor(() => expect(base()).toBeEnabled())
    expect(screen.queryByRole('combobox', { name: 'Template' })).not.toBeInTheDocument()
  })

  it('starts on None, then prefills name, base and prompt from the chosen template, all still editable', async () => {
    const user = userEvent.setup()
    const onSubmit = renderDialog()
    await waitFor(() => expect(base()).toBeEnabled())
    expect(template()).toHaveValue('')
    expect(screen.getAllByRole('option', { name: /None|Review|Explain/ }).map((o) => o.textContent)).toEqual([
      'None',
      'Review',
      'Explain',
    ])
    await user.selectOptions(template(), 'Review')
    // {n} follows the highest number in use, archived tasks included.
    expect(name()).toHaveValue('review-5')
    expect(base()).toHaveValue('origin/develop')
    expect(prompt()).toHaveValue('Review the diff')

    await user.type(name(), '-auth')
    await user.selectOptions(base(), 'main')
    await user.type(prompt(), ' for security')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).toHaveBeenCalledWith(
      'review-5-auth',
      { baseRef: 'main', prompt: 'Review the diff for security' },
      'Review',
    )
  })

  it("keeps what was typed when a template doesn't set that field, and clears what a template filled in", async () => {
    const user = userEvent.setup()
    renderDialog()
    await waitFor(() => expect(base()).toBeEnabled())
    await user.type(name(), 'mine')
    await user.selectOptions(template(), 'Explain')
    expect(name()).toHaveValue('mine')
    expect(prompt()).toHaveValue('Explain this repo')
    await user.selectOptions(template(), 'Review')
    expect(name()).toHaveValue('review-5')
    expect(prompt()).toHaveValue('Review the diff')
    await user.selectOptions(template(), '')
    expect(name()).toHaveValue('')
    expect(prompt()).toHaveValue('')
    expect(base()).toHaveValue('origin/main')
  })

  it("keeps the user's edits to a prefilled field when switching to a template without it", async () => {
    const user = userEvent.setup()
    renderDialog()
    await waitFor(() => expect(base()).toBeEnabled())
    await user.selectOptions(template(), 'Review')
    await user.type(prompt(), ' carefully')
    await user.selectOptions(template(), 'Explain')
    expect(prompt()).toHaveValue('Explain this repo') // Explain has its own prompt
    await user.selectOptions(template(), 'Review')
    await user.clear(name())
    await user.type(name(), 'audit')
    await user.selectOptions(template(), '')
    expect(name()).toHaveValue('audit')
  })

  it("falls back to the default branch, and says so, when the repo lacks the template's base", async () => {
    const user = userEvent.setup()
    const onSubmit = renderDialog({ templates: [{ name: 'Release', base: 'release/3.0' }] })
    await waitFor(() => expect(base()).toBeEnabled())
    await user.selectOptions(template(), 'Release')
    expect(base()).toHaveValue('origin/main')
    const note = "The template's base release/3.0 isn't in my-api: starting from origin/main, the default."
    expect(screen.getByRole('status')).toHaveTextContent(note)
    expect(base()).toHaveAccessibleDescription(note)
    await user.type(name(), 'ship')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).toHaveBeenCalledWith('ship', { baseRef: 'origin/main' }, 'Release')
    // Choosing a base by hand answers the note.
    await user.selectOptions(base(), 'main')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('opens on the given template, applying its base once the branches arrive', async () => {
    let resolve: (list: BranchList) => void = () => {}
    renderDialog({ initialTemplate: 'Review', loadBranches: () => new Promise((r) => (resolve = r)) })
    expect(template()).toHaveValue('Review')
    expect(name()).toHaveValue('review-5')
    expect(prompt()).toHaveValue('Review the diff')
    expect(base()).toBeDisabled()
    resolve(LIST)
    await waitFor(() => expect(base()).toHaveValue('origin/develop'))
  })

  it('opens on None when the given template no longer exists', async () => {
    renderDialog({ initialTemplate: 'Gone' })
    await waitFor(() => expect(base()).toBeEnabled())
    expect(template()).toHaveValue('')
    expect(name()).toHaveValue('')
  })

  it("puts today's date in the name", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 18, 9, 0))
    renderDialog({ initialTemplate: 'Daily', templates: [{ name: 'Daily', taskName: 'triage-{date}' }] })
    expect(name()).toHaveValue('triage-20261018')
    await waitFor(() => expect(base()).toBeEnabled())
  })
})
