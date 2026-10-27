import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { errorCount, formChanged, parseForm, toForm, type SettingsForm, type TemplateForm } from './settingsForm'

const form = (over: Partial<SettingsForm> = {}): SettingsForm => ({ ...toForm(DEFAULT_SETTINGS), ...over })

describe('settings form', () => {
  it('shows settings as text, args shell-quoted and the interval in seconds', () => {
    expect(toForm({ ...DEFAULT_SETTINGS, claudeArgs: ['--model', 'opus', 'two words'], pollIntervalMs: 2500 })).toEqual(
      {
        claudeArgs: "--model opus 'two words'",
        editorCommand: '',
        pollSeconds: '2.5',
        terminalFontSize: '13',
        notifications: true,
        remoteControl: true,
        skipPermissions: true,
        updateStrategy: 'rebase',
        showStatusBar: true,
        taskTemplates: [],
        dailyBudget: '',
        taskBudget: '',
        appearance: 'system',
        terminalMode: 'direct',
      },
    )
    expect(toForm({ ...DEFAULT_SETTINGS, dailyBudgetUsd: 20, taskBudgetUsd: 2.5 })).toMatchObject({
      dailyBudget: '20',
      taskBudget: '2.50',
    })
  })

  it('shows each task template with every field as text, keyed for the list', () => {
    const { taskTemplates } = toForm({
      ...DEFAULT_SETTINGS,
      taskTemplates: [
        { name: 'Review', taskName: 'review-{n}', base: 'origin/develop' },
        { name: 'Fix', prompt: 'Fix it' },
      ],
    })
    expect(taskTemplates).toEqual([
      { key: expect.any(String), name: 'Review', taskName: 'review-{n}', base: 'origin/develop', prompt: '' },
      { key: expect.any(String), name: 'Fix', taskName: '', base: '', prompt: 'Fix it' },
    ])
    expect(taskTemplates[0].key).not.toBe(taskTemplates[1].key)
  })

  it('parses the task templates back in order, trimmed, and reports each invalid field by template', () => {
    const template = (over: Partial<TemplateForm>): TemplateForm => ({
      key: 'k',
      name: '',
      taskName: '',
      base: '',
      prompt: '',
      ...over,
    })
    expect(
      parseForm(form({ taskTemplates: [template({ name: ' Fix ', base: ' main ' }), template({ name: 'Review' })] }))
        .settings?.taskTemplates,
    ).toEqual([{ name: 'Fix', base: 'main' }, { name: 'Review' }])
    const result = parseForm(
      form({
        pollSeconds: '0',
        taskTemplates: [template({ name: 'Fix' }), template({ name: 'fix', taskName: 'fix-{when}' })],
      }),
    )
    expect(result.errors).toEqual({
      pollSeconds: expect.any(String),
      taskTemplates: [
        {},
        { name: 'Another template has this name.', taskName: 'Unknown placeholder {when}: use {date} or {n}.' },
      ],
    })
  })

  it('parses the fields back, splitting args like a shell', () => {
    expect(
      parseForm(
        form({
          claudeArgs: `--model opus --append-system-prompt "be brief"`,
          editorCommand: ' code -n ',
          pollSeconds: '5',
          terminalFontSize: '15',
          notifications: false,
          remoteControl: false,
          skipPermissions: false,
          updateStrategy: 'merge',
          showStatusBar: false,
          appearance: 'dark',
          terminalMode: 'classic',
        }),
      ),
    ).toEqual({
      settings: {
        claudeArgs: ['--model', 'opus', '--append-system-prompt', 'be brief'],
        editorCommand: 'code -n',
        pollIntervalMs: 5000,
        terminalFontSize: 15,
        notifications: false,
        remoteControl: false,
        skipPermissions: false,
        updateStrategy: 'merge',
        showStatusBar: false,
        taskTemplates: [],
        dailyBudgetUsd: null,
        taskBudgetUsd: null,
        appearance: 'dark',
        terminalMode: 'classic',
      },
    })
    // toEqual skips the undefined keys: the dialog's fields never edit the clone folder or the profiles.
    expect(parseForm(form())).toEqual({
      settings: {
        ...DEFAULT_SETTINGS,
        cloneDirectory: undefined,
        profiles: undefined,
        defaultProfileBilling: undefined,
      },
    })
  })

  it('parses the budgets in dollars, empty as none', () => {
    expect(parseForm(form({ dailyBudget: ' $20 ', taskBudget: '2.5' })).settings).toMatchObject({
      dailyBudgetUsd: 20,
      taskBudgetUsd: 2.5,
    })
    expect(parseForm(form({ dailyBudget: '', taskBudget: ' ' })).settings).toMatchObject({
      dailyBudgetUsd: null,
      taskBudgetUsd: null,
    })
    expect(parseForm(form({ dailyBudget: '0', taskBudget: 'lots' })).errors).toEqual({
      dailyBudget: 'Enter an amount from $0.01 to $100,000, or leave it empty.',
      taskBudget: 'Enter an amount from $0.01 to $100,000, or leave it empty.',
    })
  })

  it('reports each invalid field', () => {
    const result = parseForm(
      form({ claudeArgs: `--model 'opus`, editorCommand: `"code`, pollSeconds: '0.5', terminalFontSize: '12.5' }),
    )
    expect(result.errors).toEqual({
      claudeArgs: expect.stringMatching(/single quote/),
      editorCommand: expect.stringMatching(/double quote/),
      pollSeconds: 'Enter a number of seconds from 1 to 30.',
      terminalFontSize: 'Enter a whole number from 8 to 32.',
    })
    expect(parseForm(form({ pollSeconds: '', terminalFontSize: '40' })).errors).toEqual({
      pollSeconds: expect.any(String),
      terminalFontSize: expect.any(String),
    })
    expect(parseForm(form({ pollSeconds: '31' })).errors).toHaveProperty('pollSeconds')
    expect(parseForm(form({ editorCommand: 'nvim' })).errors).toEqual({
      editorCommand: 'nvim runs in a terminal; choose a GUI editor (e.g. code, subl, gvim).',
    })
    expect(parseForm(form({ editorCommand: 'emacs' })).errors).toBeUndefined()
  })
})

describe('errorCount', () => {
  it('counts the invalid fields, each template field on its own', () => {
    expect(errorCount({})).toBe(0)
    expect(errorCount({ pollSeconds: 'x', dailyBudget: 'y' })).toBe(2)
    expect(errorCount({ claudeArgs: 'x', taskTemplates: [{}, { name: 'a', base: 'b' }, { prompt: 'c' }] })).toBe(4)
  })
})

describe('formChanged', () => {
  const settings = { ...DEFAULT_SETTINGS, taskTemplates: [{ name: 'Review', taskName: 'review-{n}' }] }

  it('tells an edited form from the one it started as, templates by their fields and order', () => {
    const start = toForm(settings)
    expect(formChanged(start, { ...start })).toBe(false)
    expect(formChanged(start, toForm(settings))).toBe(false) // new template keys, same fields
    expect(formChanged(start, { ...start, pollSeconds: '7' })).toBe(true)
    expect(formChanged(start, { ...start, notifications: !start.notifications })).toBe(true)
    const [review] = start.taskTemplates
    expect(formChanged(start, { ...start, taskTemplates: [{ ...review, prompt: 'Go' }] })).toBe(true)
    expect(formChanged(start, { ...start, taskTemplates: [] })).toBe(true)
  })
})
