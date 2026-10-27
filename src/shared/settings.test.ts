import { describe, expect, it } from 'vitest'
import { builtInClaudeFlags, DEFAULT_SETTINGS, effectiveClaudeFlags, normalizeSettings } from './settings'
import { MAX_PROFILES } from './profiles'
import type { Settings } from './types'

describe('normalizeSettings', () => {
  it('gives the defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 42, 'x', [], true]) expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toEqual({
      claudeArgs: [],
      editorCommand: '',
      pollIntervalMs: 3000,
      terminalFontSize: 13,
      notifications: true,
      remoteControl: true,
      skipPermissions: true,
      updateStrategy: 'rebase',
      cloneDirectory: '',
      showStatusBar: true,
      taskTemplates: [],
      dailyBudgetUsd: null,
      taskBudgetUsd: null,
      appearance: 'system',
      profiles: [],
      defaultProfileBilling: 'own',
      terminalMode: 'direct',
    })
  })

  it('keeps valid values and drops unknown keys', () => {
    const s = normalizeSettings({
      claudeArgs: ['--model', 'opus'],
      editorCommand: '  code -n ',
      pollIntervalMs: 5000,
      terminalFontSize: 15,
      notifications: false,
      remoteControl: false,
      skipPermissions: false,
      updateStrategy: 'merge',
      cloneDirectory: ' /home/me/code ',
      showStatusBar: false,
      taskTemplates: [{ name: 'Review', taskName: 'review-{n}' }],
      dailyBudgetUsd: 20,
      taskBudgetUsd: 5.5,
      appearance: 'light',
      profiles: [{ id: 'p1', name: 'Work', configDir: '/home/me/.claude-work', billing: 'company' }],
      defaultProfileBilling: 'company',
      terminalMode: 'classic',
      theme: 'light',
      __proto__: { polluted: true },
    })
    expect(s).toEqual({
      claudeArgs: ['--model', 'opus'],
      editorCommand: 'code -n',
      pollIntervalMs: 5000,
      terminalFontSize: 15,
      notifications: false,
      remoteControl: false,
      skipPermissions: false,
      updateStrategy: 'merge',
      cloneDirectory: '/home/me/code',
      showStatusBar: false,
      taskTemplates: [{ name: 'Review', taskName: 'review-{n}' }],
      dailyBudgetUsd: 20,
      taskBudgetUsd: 5.5,
      appearance: 'light',
      profiles: [{ id: 'p1', name: 'Work', configDir: '/home/me/.claude-work', billing: 'company' }],
      defaultProfileBilling: 'company',
      terminalMode: 'classic',
    })
    expect(Object.keys(s).sort()).toEqual([
      'appearance',
      'claudeArgs',
      'cloneDirectory',
      'dailyBudgetUsd',
      'defaultProfileBilling',
      'editorCommand',
      'notifications',
      'pollIntervalMs',
      'profiles',
      'remoteControl',
      'showStatusBar',
      'skipPermissions',
      'taskBudgetUsd',
      'taskTemplates',
      'terminalFontSize',
      'terminalMode',
      'updateStrategy',
    ])
  })

  it('keeps the valid task templates, and none in settings from before templates', () => {
    expect(normalizeSettings({ pollIntervalMs: 5000 }).taskTemplates).toEqual([])
    expect(
      normalizeSettings({
        taskTemplates: [{ name: ' Fix ', base: 'origin/main' }, { name: 'fix' }, { name: 'Bad', taskName: '{x}' }, 7],
      }).taskTemplates,
    ).toEqual([{ name: 'Fix', base: 'origin/main' }])
    // Not a list: the current templates stay, as for any wrongly typed value.
    const current: Settings = { ...DEFAULT_SETTINGS, taskTemplates: [{ name: 'Review' }] }
    expect(normalizeSettings({ taskTemplates: 'Review' }, current).taskTemplates).toEqual([{ name: 'Review' }])
    expect(normalizeSettings({ taskTemplates: [] }, current).taskTemplates).toEqual([])
  })

  it('keeps budgets in cents within the limits, and none in settings from before budgets', () => {
    expect(normalizeSettings({ pollIntervalMs: 5000 })).toMatchObject({ dailyBudgetUsd: null, taskBudgetUsd: null })
    expect(normalizeSettings({ dailyBudgetUsd: 12.345, taskBudgetUsd: 0.01 })).toMatchObject({
      dailyBudgetUsd: 12.35,
      taskBudgetUsd: 0.01,
    })
    expect(normalizeSettings({ dailyBudgetUsd: 1e9, taskBudgetUsd: 0.001 })).toMatchObject({
      dailyBudgetUsd: 100_000,
      taskBudgetUsd: 0.01,
    })
    // null removes a budget; anything else keeps the current one, as for any wrongly typed value.
    const current: Settings = { ...DEFAULT_SETTINGS, dailyBudgetUsd: 10, taskBudgetUsd: 2 }
    expect(normalizeSettings({ ...current, dailyBudgetUsd: null }, current)).toMatchObject({
      dailyBudgetUsd: null,
      taskBudgetUsd: 2,
    })
    for (const bad of [0, -5, '5', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(normalizeSettings({ dailyBudgetUsd: bad, taskBudgetUsd: bad }, current)).toMatchObject({
        dailyBudgetUsd: 10,
        taskBudgetUsd: 2,
      })
    }
  })

  it('keeps the valid Claude profiles, normalized, and none in settings from before profiles', () => {
    expect(normalizeSettings({ pollIntervalMs: 5000 })).toMatchObject({ profiles: [], defaultProfileBilling: 'own' })
    const p = (id: unknown, name: unknown, configDir: unknown, billing?: unknown): unknown => ({
      id,
      name,
      configDir,
      billing,
    })
    expect(
      normalizeSettings({
        profiles: [
          p('a', ' Work ', '/home/me/.claude-work/', 'company'),
          p(7, 'Bad id', '/x'),
          p('', 'Empty id', '/x'),
          p('b', 3, '/y'),
          p('c', '  ', '/y'),
          p('d', 'Relative', 'claude-d'),
          p('e', 'Nul', '/a\0b'),
          p('a', 'Same id', '/z'),
          p('f', 'Same folder', '/home/me//.claude-work'),
          p('default', 'Default again', '/q'),
          p('g', 'Home', '/home/me/.claude-home', 'free'),
          'not a profile',
          null,
        ],
      }).profiles,
    ).toEqual([
      { id: 'a', name: 'Work', configDir: '/home/me/.claude-work', billing: 'company' },
      { id: 'g', name: 'Home', configDir: '/home/me/.claude-home', billing: 'own' },
    ])
    const many = Array.from({ length: 25 }, (_, i) => p(`p${i}`, `P${i}`, `/c/${i}`, 'own'))
    const kept = normalizeSettings({ profiles: many }).profiles
    expect(kept).toHaveLength(MAX_PROFILES)
    expect(kept.at(-1)?.id).toBe(`p${MAX_PROFILES - 1}`)
    // Not a list: the current profiles stay, as for any wrongly typed value.
    const current: Settings = {
      ...DEFAULT_SETTINGS,
      profiles: [{ id: 'a', name: 'A', configDir: '/a', billing: 'own' }],
    }
    expect(normalizeSettings({ profiles: 'A' }, current).profiles).toEqual(current.profiles)
  })

  it('accepts only the two billings for the Default profile', () => {
    expect(normalizeSettings({ defaultProfileBilling: 'company' }).defaultProfileBilling).toBe('company')
    for (const defaultProfileBilling of ['free', 'Own', '', 1, null]) {
      expect(normalizeSettings({ defaultProfileBilling }).defaultProfileBilling).toBe('own')
    }
    const company: Settings = { ...DEFAULT_SETTINGS, defaultProfileBilling: 'company' }
    expect(normalizeSettings({ defaultProfileBilling: 'x' }, company).defaultProfileBilling).toBe('company')
  })

  it('keeps only an absolute clone directory', () => {
    for (const cloneDirectory of ['code', 'a\0b', 3, null]) {
      expect(normalizeSettings({ cloneDirectory }).cloneDirectory).toBe('')
    }
    expect(
      normalizeSettings({ cloneDirectory: '' }, { ...DEFAULT_SETTINGS, cloneDirectory: '/x' }).cloneDirectory,
    ).toBe('')
  })

  it('accepts only known update strategies', () => {
    expect(normalizeSettings({ updateStrategy: 'merge' }).updateStrategy).toBe('merge')
    for (const updateStrategy of ['squash', 'MERGE', 1, null]) {
      expect(normalizeSettings({ updateStrategy }).updateStrategy).toBe('rebase')
    }
    const merging: Settings = { ...DEFAULT_SETTINGS, updateStrategy: 'merge' }
    expect(normalizeSettings({ updateStrategy: 'bogus' }, merging).updateStrategy).toBe('merge')
  })

  it('accepts only known terminal modes, and loads an older file without one as "direct"', () => {
    expect(normalizeSettings({}).terminalMode).toBe('direct')
    expect(normalizeSettings({ terminalMode: 'classic' }).terminalMode).toBe('classic')
    for (const terminalMode of ['x', 'Classic', '', 3, null]) {
      expect(normalizeSettings({ terminalMode }).terminalMode).toBe('direct')
    }
    const classic: Settings = { ...DEFAULT_SETTINGS, terminalMode: 'classic' }
    expect(normalizeSettings({ terminalMode: 'x' }, classic).terminalMode).toBe('classic')
  })

  it('accepts only known appearances, and loads an older file without one as "system"', () => {
    for (const appearance of ['system', 'dark', 'light'] as const) {
      expect(normalizeSettings({ appearance }).appearance).toBe(appearance)
    }
    for (const appearance of ['auto', 'Light', '', 1, null]) {
      expect(normalizeSettings({ appearance }).appearance).toBe('system')
    }
    const light: Settings = { ...DEFAULT_SETTINGS, appearance: 'light' }
    expect(normalizeSettings({ appearance: 'sepia' }, light).appearance).toBe('light')
    // A settings.json from before the setting existed: everything else unchanged.
    const old = { ...DEFAULT_SETTINGS, terminalFontSize: 16, appearance: undefined }
    expect(normalizeSettings(old)).toEqual({ ...DEFAULT_SETTINGS, terminalFontSize: 16 })
  })

  it('clamps and rounds numbers', () => {
    expect(normalizeSettings({ pollIntervalMs: 10, terminalFontSize: 2 })).toMatchObject({
      pollIntervalMs: 1000,
      terminalFontSize: 8,
    })
    expect(normalizeSettings({ pollIntervalMs: 1e9, terminalFontSize: 100 })).toMatchObject({
      pollIntervalMs: 30000,
      terminalFontSize: 32,
    })
    expect(normalizeSettings({ pollIntervalMs: 2500.4, terminalFontSize: 14.6 })).toMatchObject({
      pollIntervalMs: 2500,
      terminalFontSize: 15,
    })
  })

  it('falls back per field for wrong types, NaN and NUL characters', () => {
    expect(
      normalizeSettings({
        claudeArgs: ['--model', 3],
        editorCommand: 7,
        pollIntervalMs: '5000',
        terminalFontSize: Number.NaN,
        notifications: 'yes',
        remoteControl: 1,
        skipPermissions: 'true',
      }),
    ).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ claudeArgs: 'opus' }).claudeArgs).toEqual([])
    expect(normalizeSettings({ claudeArgs: ['a\0b'] }).claudeArgs).toEqual([])
    expect(normalizeSettings({ editorCommand: 'code\0' }).editorCommand).toBe('')
  })

  it('falls back to the given base, so a bad patch keeps the current value', () => {
    const current: Settings = { ...DEFAULT_SETTINGS, claudeArgs: ['-v'], terminalFontSize: 20 }
    expect(normalizeSettings({ ...current, terminalFontSize: 'big', claudeArgs: null }, current)).toEqual(current)
  })

  it('returns a copy, never the caller’s array', () => {
    const args = ['--model', 'opus']
    const s = normalizeSettings({ claudeArgs: args })
    expect(s.claudeArgs).not.toBe(args)
    expect(normalizeSettings({}).claudeArgs).not.toBe(DEFAULT_SETTINGS.claudeArgs)
    const current: Settings = { ...DEFAULT_SETTINGS, taskTemplates: [{ name: 'Review' }] }
    const kept = normalizeSettings({}, current).taskTemplates
    expect(kept).toEqual(current.taskTemplates)
    expect(kept).not.toBe(current.taskTemplates)
    expect(kept[0]).not.toBe(current.taskTemplates[0])
  })
})

describe('builtInClaudeFlags / effectiveClaudeFlags', () => {
  const settings = (
    claudeArgs: string[],
    remoteControl = true,
    skipPermissions = true,
  ): Pick<Settings, 'claudeArgs' | 'remoteControl' | 'skipPermissions'> => ({
    claudeArgs,
    remoteControl,
    skipPermissions,
  })

  it('adds the enabled flags, unless the user arguments already set that option', () => {
    expect(builtInClaudeFlags(settings([]), 't/r/x')).toEqual([
      '--remote-control',
      't/r/x',
      '--dangerously-skip-permissions',
    ])
    expect(builtInClaudeFlags(settings([], false, false), 'l')).toEqual([])
    expect(builtInClaudeFlags(settings(['--remote-control=mine', '--permission-mode', 'plan']), 'l')).toEqual([])
  })

  it('says what applies once the user arguments are added', () => {
    expect(effectiveClaudeFlags(settings([]))).toEqual({ remoteControl: true, skipPermissions: true })
    expect(effectiveClaudeFlags(settings([], false, false))).toEqual({ remoteControl: false, skipPermissions: false })
    // --permission-mode stops the app's flag, so permissions are skipped only for bypassPermissions.
    expect(effectiveClaudeFlags(settings(['--permission-mode', 'acceptEdits']))).toEqual({
      remoteControl: true,
      skipPermissions: false,
    })
    expect(effectiveClaudeFlags(settings(['--permission-mode=plan']))).toMatchObject({ skipPermissions: false })
    expect(effectiveClaudeFlags(settings(['--permission-mode', 'bypassPermissions'], true, false))).toMatchObject({
      skipPermissions: true,
    })
    expect(effectiveClaudeFlags(settings(['--permission-mode=bypassPermissions'], true, false))).toMatchObject({
      skipPermissions: true,
    })
    // The user's own flags apply whatever the toggles say.
    expect(
      effectiveClaudeFlags(settings(['--dangerously-skip-permissions', '--remote-control'], false, false)),
    ).toEqual({ remoteControl: true, skipPermissions: true })
  })
})
