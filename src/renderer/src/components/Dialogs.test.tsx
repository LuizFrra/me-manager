import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BranchList, TaskTemplate } from '../../../shared/types'
import {
  ArchiveTaskDialog,
  BudgetDialog,
  BulkConfirmDialog,
  ChooseThemeDialog,
  CommitDialog,
  ConfirmRemoveDialog,
  ConflictDialog,
  DeleteArchivedTaskDialog,
  NameDialog,
  NewTaskDialog,
  NotesDialog,
  RemoveTaskDialog,
  ReviewCommentDialog,
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

  it('focuses Cancel so Enter loses nothing, closes with Esc (not while removing), and counts in words', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const onCancel = vi.fn()
    render(
      <RemoveTaskDialog
        taskName="fix"
        work={{ uncommittedFiles: ['src/login.ts'], unpushedCommits: ['abc1234 wip', 'def5678 more'] }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Remove fix' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('heading', { name: '1 uncommitted file' })).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: '2 unpushed commits' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Remove anyway' }))
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2) // removing can't be cancelled
    finish()
  })
})

describe('NameDialog', () => {
  it('explains a name `validate` refuses as it is typed, with the button and Enter off', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => {})
    render(
      <NameDialog
        title="Rename theme"
        placeholder=""
        initial="Client X"
        submitLabel="Rename"
        note="The branch and folder keep their original name."
        validate={(name) => (name.trim().toLowerCase() === 'acme' ? 'A theme named “Acme” already exists.' : null)}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    const box = screen.getByRole('textbox', { name: 'Name' })
    expect(box).toHaveAccessibleDescription('The branch and folder keep their original name.')
    await user.clear(box)
    await user.type(box, 'ACME{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('A theme named “Acme” already exists.')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box).toHaveAccessibleDescription(
      'A theme named “Acme” already exists. The branch and folder keep their original name.',
    )
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
    await user.type(box, ' Corp{Enter}')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onSubmit).toHaveBeenCalledWith('ACME Corp')
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

  it('says to use a dot for cents, and takes an amount written as it is shown ("1,500")', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<BudgetDialog taskName="t" initial={null} defaultBudget={null} onSave={onSave} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Budget' })
    await user.type(input, '12,50')
    expect(screen.getByRole('alert')).toHaveTextContent('Use a dot for cents, e.g. 12.50.')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '1,500{Enter}')
    expect(onSave).toHaveBeenCalledWith(1500)
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

describe('dialogs cancel with Esc from any of their controls, not only the text field', () => {
  it.each([
    [
      'Name',
      (onCancel: () => void) => <NameDialog title="New theme" placeholder="" onSubmit={vi.fn()} onCancel={onCancel} />,
    ],
    [
      'RunCommand',
      (onCancel: () => void) => (
        <RunCommandDialog itemName="api" kind="repo" initial="" onSave={vi.fn()} onCancel={onCancel} />
      ),
    ],
    [
      'Budget',
      (onCancel: () => void) => (
        <BudgetDialog taskName="t" initial={null} defaultBudget={null} onSave={vi.fn()} onCancel={onCancel} />
      ),
    ],
    ['Notes', (onCancel: () => void) => <NotesDialog taskName="t" initial="" onSave={vi.fn()} onCancel={onCancel} />],
    [
      'ReviewComment',
      (onCancel: () => void) => <ReviewCommentDialog location="a.ts:3" onSave={vi.fn()} onCancel={onCancel} />,
    ],
  ])('%s', async (_name, dialog) => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(dialog(onCancel))
    const form = screen.getByRole('dialog')
    expect(form).toHaveAttribute('aria-modal', 'true')
    await user.tab() // from the text field to the first button
    expect(within(form).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('NewTaskDialog name', () => {
  const LIST: BranchList = { default: 'origin/main', branches: ['origin/main'] }
  const TASKS = [
    { name: 'fix login bug', slug: 'fix-login-bug' },
    { name: 'Old idea', slug: 'old-idea', archived: true },
  ]
  const name = (): HTMLElement => screen.getByRole('textbox', { name: 'Name' })
  const create = (): HTMLElement => screen.getByRole('button', { name: 'Create' })

  const renderDialog = (): ReturnType<typeof vi.fn> => {
    const onSubmit = vi.fn(async () => {})
    render(
      <NewTaskDialog
        repoName="my-api"
        themeSlug="client-x"
        loadBranches={async () => LIST}
        tasks={TASKS}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    return onSubmit
  }

  it('shows the branch the name gives as it is typed', async () => {
    const user = userEvent.setup()
    renderDialog()
    expect(name()).toHaveAccessibleDescription('Also names the task’s branch and folder.')
    await user.type(name(), 'Add search!')
    expect(name()).toHaveAccessibleDescription('Branch: claude/client-x/add-search')
    expect(name()).not.toHaveAttribute('aria-invalid', 'true')
    expect(create()).toBeEnabled()
  })

  it('explains a name main would refuse before anything is created, with Create off', async () => {
    const user = userEvent.setup()
    const onSubmit = renderDialog()
    await user.type(name(), '!!!')
    expect(screen.getByRole('alert')).toHaveTextContent(/letters or numbers/)
    expect(name()).toHaveAttribute('aria-invalid', 'true')
    expect(create()).toBeDisabled()

    await user.clear(name())
    await user.type(name(), 'Fix Login Bug')
    expect(name()).toHaveAccessibleDescription('A task named “fix login bug” already exists.')
    await user.keyboard('{Control>}{Enter}{/Control}{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()

    await user.clear(name())
    await user.type(name(), 'fix-login-bug')
    expect(screen.getByRole('alert')).toHaveTextContent('already uses the branch this name gives (…/fix-login-bug)')

    await user.clear(name())
    await user.type(name(), 'old idea')
    expect(screen.getByRole('alert')).toHaveTextContent('A task named “Old idea” already exists (archived).')

    await user.type(name(), ' 2')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(create())
    expect(onSubmit).toHaveBeenCalledWith('old idea 2', expect.anything(), undefined)
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
        tasks={[
          { name: 'review-1', slug: 'review-1' },
          { name: 'Review-4', slug: 'review-4' },
        ]}
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

  it("keeps the composer's name and prompt when a template is chosen, and back on None", async () => {
    const user = userEvent.setup()
    renderDialog({ initialName: 'Bump deps', initialPrompt: 'Bump the deps carefully' })
    await waitFor(() => expect(base()).toBeEnabled())
    expect(name()).toHaveValue('Bump deps')
    expect(prompt()).toHaveValue('Bump the deps carefully')
    await user.selectOptions(template(), 'Review')
    expect(name()).toHaveValue('Bump deps')
    expect(prompt()).toHaveValue('Bump the deps carefully')
    expect(base()).toHaveValue('origin/develop')
    await user.selectOptions(template(), 'None')
    expect(name()).toHaveValue('Bump deps')
    expect(prompt()).toHaveValue('Bump the deps carefully')
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

describe('BulkConfirmDialog', () => {
  const bulkTask = (
    name: string,
    uncommittedFiles: string[] = [],
  ): Parameters<typeof BulkConfirmDialog>[0]['tasks'][0] => ({
    id: name,
    name,
    repoName: 'api',
    branch: `b/${name}`,
    work: { uncommittedFiles, unpushedCommits: [] },
  })

  it('lists at most 5 of a task’s files, counting the rest', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f) => `src/${f}.ts`)
    render(
      <BulkConfirmDialog
        action="remove"
        tasks={[bulkTask('fix', files), bulkTask('docs')]}
        strategy="rebase"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('7 uncommitted files')).toBeInTheDocument()
    expect(screen.getByText('src/e.ts')).toBeInTheDocument()
    expect(screen.queryByText('src/f.ts')).not.toBeInTheDocument()
    expect(screen.getByText('and 2 more')).toBeInTheDocument()
  })

  it('turns Archive off when every task would be skipped, and Esc cancels', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <BulkConfirmDialog
        action="archive"
        tasks={[bulkTask('fix', ['a.ts']), bulkTask('docs', ['b.ts'])]}
        strategy="rebase"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('button', { name: 'Archive 0 tasks' })).toBeDisabled()
    expect(screen.getAllByText(/Skipped: it has uncommitted or untracked files/)).toHaveLength(2)
    await userEvent.setup().keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('says how Update from base rebases, and focuses its confirm button', () => {
    render(
      <BulkConfirmDialog
        action="update"
        tasks={[bulkTask('fix'), bulkTask('docs')]}
        strategy="rebase"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText(/git rebase/)).toBeInTheDocument()
    expect(screen.getByText('b/docs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update 2 tasks' })).toHaveFocus()
  })
})

describe('CommitDialog', () => {
  const CHANGES = { files: [{ path: 'a.ts', status: 'M' as const, added: 1, removed: 0, binary: false }] }

  it("can't be closed with Esc while committing, so a failure still finds the message", async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    // Resolves without closing the dialog, as App does when the commit fails.
    const onCommit = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const onCancel = vi.fn()
    render(
      <CommitDialog
        taskName="t"
        branch="b"
        loadChanges={async () => CHANGES}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    )
    await screen.findByText('1 file will be committed')
    const message = screen.getByRole('textbox', { name: 'Commit message' })
    await user.type(message, 'Fix it{Control>}{Enter}{/Control}')
    expect(onCommit).toHaveBeenCalledWith('Fix it')
    await user.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled())
    expect(message).toHaveValue('Fix it')
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows why the commit failed in the dialog, keeping the message, with the full output on demand', async () => {
    const user = userEvent.setup()
    const output = `git commit failed: husky - pre-commit script failed (code 1) ${'eslint: no-unused-vars '.repeat(20)}`
    const onCommit = vi.fn().mockRejectedValueOnce(new Error(output)).mockResolvedValueOnce(undefined)
    render(
      <CommitDialog taskName="t" branch="b" loadChanges={async () => CHANGES} onCommit={onCommit} onCancel={vi.fn()} />,
    )
    await screen.findByText('1 file will be committed')
    const message = screen.getByRole('textbox', { name: 'Commit message' })
    await user.type(message, 'Fix it')
    await user.click(screen.getByRole('button', { name: 'Commit' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^Could not commit husky - pre-commit script failed \(code 1\) eslint/)
    expect(within(alert).getAllByText(/husky/)[0].textContent!.length).toBeLessThan(200)
    expect(message).toHaveValue('Fix it')
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled()

    await user.click(within(alert).getByText('Full output'))
    expect(within(alert).getByText(output.replace('git commit failed: ', '').trim())).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Commit' })) // tried again: the error goes
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
