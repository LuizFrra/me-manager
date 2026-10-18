import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { parseForm, toForm, type SettingsForm } from './settingsForm'

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
      },
    )
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
      },
    })
    expect(parseForm(form())).toEqual({ settings: DEFAULT_SETTINGS })
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
