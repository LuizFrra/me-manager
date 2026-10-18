import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { emptyUiState } from '../../shared/uiState'
import type { UiState } from '../../shared/types'
import { UiStateStore } from './uiState'

let file: string

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'mm-ui-')), 'nested', 'ui-state.json')
})

const saved: UiState = {
  version: 1,
  selected: { themeId: 't1', itemId: 'r1', taskId: 'k1' },
  collapsed: ['t2'],
  panels: { k1: { open: true, tab: 'search', selected: 'README.md' } },
  panelWidth: 0.5,
  sidebarFilter: 'api',
}

describe('UiStateStore', () => {
  it('gives an empty UI state when there is no file', async () => {
    await expect(new UiStateStore(file).load()).resolves.toEqual(emptyUiState())
  })

  it('round-trips the UI state and keeps the previous version as .bak', async () => {
    const store = new UiStateStore(file)
    await store.save(emptyUiState())
    await store.save(saved)
    await expect(new UiStateStore(file).load()).resolves.toEqual(saved)
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual(emptyUiState())
  })

  it('runs overlapping saves one at a time, the last one winning', async () => {
    const store = new UiStateStore(file)
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ ...saved, collapsed: [`t${n}`] })))
    await expect(new UiStateStore(file).load()).resolves.toMatchObject({ collapsed: ['t5'] })
  })

  it('falls back to .bak when the file is corrupt, and to an empty state when both are unusable', async () => {
    const store = new UiStateStore(file)
    await store.save(saved)
    await store.save({ ...saved, sidebarFilter: 'newer' })
    await writeFile(file, '{ not json')
    await expect(new UiStateStore(file).load()).resolves.toEqual(saved)
    await writeFile(`${file}.bak`, '[1, 2]')
    await expect(new UiStateStore(file).load()).resolves.toEqual(emptyUiState())
  })
})
