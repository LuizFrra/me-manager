import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { MAX_TASK_TEMPLATES } from '../../../shared/templates'
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

describe('SettingsDialog: budgets', () => {
  it('shows no budgets by default and saves the ones typed', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={onSave} onCancel={vi.fn()} />)
    const daily = screen.getByLabelText('Daily budget')
    const task = screen.getByLabelText('Task budget')
    expect(daily).toHaveValue('')
    expect(task).toHaveValue('')
    expect(daily).toHaveAccessibleDescription(/all tasks and folders/)
    await user.type(daily, '20')
    await user.type(task, '2.5')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dailyBudgetUsd: 20, taskBudgetUsd: 2.5 }))
  })

  it('removes a budget that is emptied, and keeps Save off for an invalid amount', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(
      <SettingsDialog
        settings={{ ...DEFAULT_SETTINGS, dailyBudgetUsd: 20, taskBudgetUsd: 5 }}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    const daily = screen.getByLabelText('Daily budget')
    expect(daily).toHaveValue('20')
    await user.clear(daily)
    await user.clear(screen.getByLabelText('Task budget'))
    await user.type(screen.getByLabelText('Task budget'), '-1')
    expect(screen.getByLabelText('Task budget')).toBeInvalid()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.clear(screen.getByLabelText('Task budget'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dailyBudgetUsd: null, taskBudgetUsd: null }))
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

describe('SettingsDialog: appearance', () => {
  it('shows the saved appearance and saves another', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={{ ...DEFAULT_SETTINGS, appearance: 'dark' }} onSave={onSave} onCancel={vi.fn()} />)
    const group = screen.getByRole('group', { name: 'Appearance' })
    expect(group).toHaveAccessibleDescription(/the terminal, code and diagrams too/)
    expect(screen.getByRole('radio', { name: /^Dark/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^System/ })).not.toBeChecked()
    await user.click(screen.getByRole('radio', { name: /^Light/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ appearance: 'light' }))
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

describe('SettingsDialog: task templates', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    skipPermissions: false,
    taskTemplates: [
      { name: 'Review', taskName: 'review-{n}' },
      { name: 'Fix', prompt: 'Fix it' },
    ],
  }
  const section = (): HTMLElement => screen.getByRole('region', { name: 'Task templates' })
  const template = (name: string): HTMLElement => within(section()).getByRole('group', { name: `Template ${name}` })

  it('lists the templates with their fields, and explains the name pattern', () => {
    render(<SettingsDialog settings={settings} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(
      within(section())
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Template Review', 'Template Fix'])
    expect(within(template('Review')).getByLabelText('Name')).toHaveValue('Review')
    expect(within(template('Review')).getByLabelText('Task name')).toHaveValue('review-{n}')
    expect(within(template('Fix')).getByLabelText('Initial prompt')).toHaveValue('Fix it')
    expect(within(template('Fix')).getByLabelText('Base branch')).toHaveValue('')
    expect(section()).toHaveTextContent('{date}')
    expect(section()).toHaveTextContent('{n}')
  })

  it('adds, edits, reorders and deletes templates, and saves them in order', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={settings} onSave={onSave} onCancel={vi.fn()} />)
    const taskName = within(template('Review')).getByLabelText('Task name')
    await user.clear(taskName)
    await user.type(taskName, 'review-{{date}-{{n}')

    await user.click(within(template('Fix')).getByRole('button', { name: 'Move template Fix up' }))
    expect(
      within(section())
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Template Fix', 'Template Review'])
    // At the top, Up is off: focus goes to Down, so the keyboard user isn't left on nothing.
    expect(within(template('Fix')).getByRole('button', { name: 'Move template Fix up' })).toBeDisabled()
    expect(within(template('Fix')).getByRole('button', { name: 'Move template Fix down' })).toHaveFocus()

    await user.click(within(section()).getByRole('button', { name: 'Add template' }))
    const added = within(section()).getByRole('group', { name: 'Template 3' })
    expect(within(added).getByLabelText('Name')).toHaveFocus()
    await user.keyboard('Docs')
    await user.type(within(template('Docs')).getByLabelText('Base branch'), 'develop')

    await user.click(within(template('Review')).getByRole('button', { name: 'Delete template Review' }))
    expect(within(section()).queryByRole('group', { name: 'Template Review' })).not.toBeInTheDocument()
    expect(within(template('Docs')).getByRole('button', { name: 'Delete template Docs' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        taskTemplates: [
          { name: 'Fix', prompt: 'Fix it' },
          { name: 'Docs', base: 'develop' },
        ],
      }),
    )
  })

  it('saves edits to an existing template', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => {})
    render(<SettingsDialog settings={settings} onSave={onSave} onCancel={vi.fn()} />)
    await user.type(within(template('Fix')).getByLabelText('Initial prompt'), ', then add a test')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        taskTemplates: [
          { name: 'Review', taskName: 'review-{n}' },
          { name: 'Fix', prompt: 'Fix it, then add a test' },
        ],
      }),
    )
  })

  it('shows what is wrong under each field, as its description, and keeps Save off until fixed', async () => {
    const user = userEvent.setup()
    render(<SettingsDialog settings={settings} onSave={vi.fn()} onCancel={vi.fn()} />)
    await user.click(within(section()).getByRole('button', { name: 'Add template' }))
    const added = (): HTMLElement => within(section()).getByRole('group', { name: /^Template (3|review)$/ })
    const name = within(added()).getByLabelText('Name')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription(/Enter a name\./)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.type(name, 'review')
    expect(name).toHaveAccessibleDescription(/Another template has this name\./)
    const pattern = within(added()).getByLabelText('Task name')
    await user.type(pattern, 'fix-{{when}')
    expect(pattern).toHaveAttribute('aria-invalid', 'true')
    expect(pattern).toHaveAccessibleDescription('Unknown placeholder {when}: use {date} or {n}.')

    await user.clear(name)
    await user.type(name, 'Fix later')
    await user.clear(pattern)
    await user.type(pattern, 'fix-{{n}')
    expect(name).toHaveAttribute('aria-invalid', 'false')
    expect(pattern).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('stops adding at the limit, and says so', () => {
    const many = Array.from({ length: MAX_TASK_TEMPLATES }, (_, i) => ({ name: `t${i}` }))
    render(<SettingsDialog settings={{ ...settings, taskTemplates: many }} onSave={vi.fn()} onCancel={vi.fn()} />)
    const add = within(section()).getByRole('button', { name: 'Add template' })
    expect(add).toBeDisabled()
    expect(add).toHaveAccessibleDescription(`At most ${MAX_TASK_TEMPLATES} templates.`)
  })
})

describe('SettingsDialog: fields to fix', () => {
  it('says how many fields keep Save off, and takes you to the first one', async () => {
    const user = userEvent.setup()
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /to fix/ })).not.toBeInTheDocument()
    const poll = screen.getByLabelText('Refresh interval')
    await user.clear(poll)
    await user.click(screen.getByRole('button', { name: 'Add template' })) // its name is required
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    const fix = screen.getByRole('button', { name: '2 fields to fix' })
    expect(save).toHaveAccessibleDescription('2 fields to fix')
    await user.click(fix)
    expect(poll).toHaveFocus()
    await user.type(poll, '3')
    expect(screen.getByRole('button', { name: '1 field to fix' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '1 field to fix' }))
    expect(within(screen.getByRole('group', { name: 'Template 1' })).getByLabelText('Name')).toHaveFocus()
  })
})

describe('SettingsDialog: Esc with unsaved changes', () => {
  const settings = { ...DEFAULT_SETTINGS, skipPermissions: false } // no permissions alert

  it('closes at once when nothing was changed', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<SettingsDialog settings={settings} onSave={vi.fn()} onCancel={onCancel} />)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('asks before discarding edits: a second Esc or Discard closes, Keep editing goes back', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<SettingsDialog settings={settings} onSave={vi.fn()} onCancel={onCancel} />)
    const editor = screen.getByLabelText('Editor command')
    await user.type(editor, 'subl')
    await user.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Discard your changes? Esc again discards them.')
    expect(editor).toHaveFocus() // still where it was

    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText(/Discard your changes/)).not.toBeInTheDocument()
    expect(editor).toHaveValue('subl')
    expect(editor).toHaveFocus()

    await user.keyboard('{Escape}')
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('discards from its button, and Cancel needs no confirmation', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<SettingsDialog settings={settings} onSave={vi.fn()} onCancel={onCancel} />)
    await user.click(screen.getByRole('checkbox', { name: /Status bar/ }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('SettingsDialog: number fields and the mouse wheel', () => {
  it("doesn't let the wheel change a focused number, scrolling the dialog instead", async () => {
    const user = userEvent.setup()
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onCancel={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    let scrollTop = 0
    Object.defineProperty(dialog, 'scrollTop', { get: () => scrollTop, set: (v: number) => (scrollTop = v) })
    for (const name of ['Refresh interval', 'Terminal font size']) {
      const field = screen.getByLabelText(name)
      // Not focused: the wheel is the page's, as usual.
      expect(fireEvent.wheel(field, { deltaY: 40 })).toBe(true)
      await user.click(field)
      const before = scrollTop
      expect(fireEvent.wheel(field, { deltaY: 40 })).toBe(false) // Chromium would step the value
      expect(scrollTop).toBe(before + 40)
      expect(field).toHaveFocus()
    }
  })
})

describe('SettingsDialog: while saving', () => {
  it("doesn't close on Esc, as Cancel doesn't", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onSave = vi.fn(() => new Promise<void>(() => {}))
    render(
      <SettingsDialog settings={{ ...DEFAULT_SETTINGS, skipPermissions: false }} onSave={onSave} onCancel={onCancel} />,
    )
    await user.type(screen.getByLabelText('Editor command'), 'subl')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await user.click(screen.getByLabelText('Editor command'))
    await user.keyboard('{Escape}{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
