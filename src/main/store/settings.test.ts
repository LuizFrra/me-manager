import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { Settings } from '../../shared/types'
import { MemorySettingsStore } from '../app/fakes'
import { SettingsService, SettingsStore } from './settings'

let file: string

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'mm-settings-')), 'nested', 'settings.json')
})

const custom: Settings = {
  claudeArgs: ['--model', 'opus'],
  editorCommand: 'code -n',
  pollIntervalMs: 5000,
  terminalFontSize: 15,
  notifications: false,
  remoteControl: false,
  skipPermissions: true,
  updateStrategy: 'merge',
}

describe('SettingsStore', () => {
  it('gives the defaults when the file does not exist', async () => {
    await expect(new SettingsStore(file).load()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips settings and keeps the previous version as .bak', async () => {
    const store = new SettingsStore(file)
    await store.save(DEFAULT_SETTINGS)
    await store.save(custom)
    await expect(new SettingsStore(file).load()).resolves.toEqual(custom)
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to .bak when the file is corrupt, and to the defaults when that is gone too', async () => {
    const store = new SettingsStore(file)
    await store.save(custom)
    await store.save({ ...custom, terminalFontSize: 20 })
    await writeFile(file, '{ not json', 'utf8')
    await expect(new SettingsStore(file).load()).resolves.toEqual(custom)
    await writeFile(file + '.bak', 'garbage', 'utf8')
    await expect(new SettingsStore(file).load()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  it('normalizes what it reads: unknown keys dropped, bad values defaulted, numbers clamped', async () => {
    const store = new SettingsStore(file)
    await store.save(DEFAULT_SETTINGS)
    await writeFile(
      file,
      JSON.stringify({ claudeArgs: ['-v'], pollIntervalMs: 50, terminalFontSize: 'huge', extra: 1 }),
      'utf8',
    )
    await expect(store.load()).resolves.toEqual({ ...DEFAULT_SETTINGS, claudeArgs: ['-v'], pollIntervalMs: 1000 })
  })

  it('writes only known keys', async () => {
    await new SettingsStore(file).save({ ...custom, extra: true } as Settings)
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort()).toEqual(Object.keys(custom).sort())
  })
})

describe('SettingsService', () => {
  it('loads on init, merges patches, saves and returns the result', async () => {
    const store = new MemorySettingsStore(custom)
    const service = new SettingsService(store)
    expect(service.get()).toEqual(DEFAULT_SETTINGS)
    await service.init()
    expect(service.get()).toEqual(custom)
    const next = await service.update({ terminalFontSize: 18 })
    expect(next).toEqual({ ...custom, terminalFontSize: 18 })
    expect(service.get()).toEqual(next)
    expect(store.saved.at(-1)).toEqual(next)
  })

  it('ignores invalid and unknown patch values, keeping the current ones', async () => {
    const service = new SettingsService(new MemorySettingsStore(custom))
    await service.init()
    const patch = { pollIntervalMs: 'fast', claudeArgs: [1], other: 'x' } as unknown as Partial<Settings>
    expect(await service.update(patch)).toEqual(custom)
    expect(await service.update(null as unknown as Partial<Settings>)).toEqual(custom)
  })

  it('applies concurrent updates one after the other, losing none', async () => {
    const service = new SettingsService(new MemorySettingsStore())
    await Promise.all([service.update({ terminalFontSize: 20 }), service.update({ notifications: false })])
    expect(service.get()).toMatchObject({ terminalFontSize: 20, notifications: false })
  })

  it('keeps the current settings when saving fails, and recovers', async () => {
    const store = new MemorySettingsStore()
    const service = new SettingsService(store)
    store.save = async () => {
      throw new Error('disk full')
    }
    await expect(service.update({ terminalFontSize: 20 })).rejects.toThrow('disk full')
    expect(service.get()).toEqual(DEFAULT_SETTINGS)
    store.save = async () => {}
    await expect(service.update({ terminalFontSize: 21 })).resolves.toMatchObject({ terminalFontSize: 21 })
  })
})
