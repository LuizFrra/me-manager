import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'
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
    })
    expect(Object.keys(s).sort()).toEqual([
      'claudeArgs',
      'cloneDirectory',
      'editorCommand',
      'notifications',
      'pollIntervalMs',
      'remoteControl',
      'skipPermissions',
      'terminalFontSize',
      'updateStrategy',
    ])
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
  })
})
