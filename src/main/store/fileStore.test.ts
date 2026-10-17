import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileStore } from './fileStore'
import { addTheme, emptyState } from './mutations'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-store-'))
  file = join(dir, 'nested', 'state.json')
})

describe('FileStore', () => {
  it('returns empty state when the file does not exist', async () => {
    await expect(new FileStore(file).load()).resolves.toEqual(emptyState())
  })
  it('round-trips state', async () => {
    const store = new FileStore(file)
    const state = addTheme(emptyState(), 'Client X')
    await store.save(state)
    await expect(store.load()).resolves.toEqual(state)
  })
  it('keeps the previous version as .bak', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(first)
  })
  it('falls back to .bak when the main file is corrupt', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    await writeFile(file, '{ not json', 'utf8')
    await expect(store.load()).resolves.toEqual(first)
  })
  it('throws when both files are unreadable', async () => {
    const store = new FileStore(file)
    await store.save(emptyState())
    await writeFile(file, 'garbage', 'utf8')
    await expect(store.load()).rejects.toThrow(/Could not read/)
  })
})
