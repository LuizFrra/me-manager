import { describe, expect, it } from 'vitest'
import type { AppState } from './types'
import { emptyUiState, MAX_UI_PANELS, normalizeUiState } from './uiState'

function app(taskIds: string[] = ['k1', 'k2']): AppState {
  return {
    version: 1,
    themes: [
      {
        id: 't1',
        name: 'Client X',
        slug: 'client-x',
        items: [
          {
            id: 'r1',
            kind: 'repo',
            name: 'api',
            slug: 'api',
            path: '/code/api',
            tasks: taskIds.map((id) => ({
              id,
              name: id,
              slug: id,
              branch: `claude/client-x/${id}`,
              worktreePath: `/wt/${id}`,
              baseRef: 'origin/main',
              createdAt: '2026-01-01T00:00:00.000Z',
            })),
          },
          { id: 'f1', kind: 'folder', name: 'notes', slug: 'notes', path: '/docs/notes' },
        ],
      },
    ],
  }
}

describe('normalizeUiState', () => {
  it('keeps a valid state as it is', () => {
    const ui = {
      version: 1,
      selected: { themeId: 't1', itemId: 'r1', taskId: 'k1' },
      collapsed: ['t1', 'r1'],
      panels: {
        k1: { open: true, tab: 'changes', selected: 'src/a.ts' },
        f1: { open: false, tab: 'search' },
      },
      panelWidth: 0.45,
      sidebarFilter: 'fix',
      lastTemplates: { r1: 'Review' },
    }
    expect(normalizeUiState(ui, app())).toEqual(ui)
  })

  it('drops a selection, panels and collapsed ids whose targets no longer exist', () => {
    const ui = normalizeUiState(
      {
        selected: { themeId: 't1', itemId: 'r1', taskId: 'gone' },
        collapsed: ['t1', 'gone-theme', 'r1', 'f1', 'r1'],
        panels: { gone: { open: true, tab: 'files' }, k2: { open: true, tab: 'files' } },
      },
      app(),
    )
    expect(ui).toEqual({ version: 1, collapsed: ['t1', 'r1'], panels: { k2: { open: true, tab: 'files' } } })
  })

  it('drops a selection that names the wrong theme or item, or is a repo without its task', () => {
    for (const selected of [
      { themeId: 't2', itemId: 'r1', taskId: 'k1' },
      { themeId: 't1', itemId: 'f1', taskId: 'k1' },
      { themeId: 't1', itemId: 'r1' },
      { themeId: 't1', itemId: 'f1', taskId: 5 },
      'k1',
    ]) {
      expect(normalizeUiState({ selected }, app()).selected, JSON.stringify(selected)).toBeUndefined()
    }
    expect(normalizeUiState({ selected: { themeId: 't1', itemId: 'f1' } }, app()).selected).toEqual({
      themeId: 't1',
      itemId: 'f1',
    })
  })

  it('cleans up panel entries: unknown tabs, Changes for a folder, bad paths, and defaults left out', () => {
    const ui = normalizeUiState(
      {
        panels: {
          k1: { open: 'yes', tab: 'bogus', selected: 42 },
          k2: { open: true, tab: 'files', selected: 'a\0b', extra: 1 },
          f1: { open: true, tab: 'changes', selected: 'x.md' },
        },
      },
      app(),
    )
    expect(ui.panels).toEqual({ k2: { open: true, tab: 'files' }, f1: { open: true, tab: 'files', selected: 'x.md' } })
  })

  it(`keeps the ${MAX_UI_PANELS} most recent panel entries, and always the selected one`, () => {
    const ids = Array.from({ length: MAX_UI_PANELS + 50 }, (_, i) => `k${i}`)
    const panels = Object.fromEntries(ids.map((id) => [id, { open: true, tab: 'files' }]))
    const kept = normalizeUiState({ panels }, app(ids)).panels
    expect(Object.keys(kept)).toHaveLength(MAX_UI_PANELS)
    expect(Object.keys(kept)[0]).toBe('k50')
    const withSelected = normalizeUiState(
      { panels, selected: { themeId: 't1', itemId: 'r1', taskId: 'k3' } },
      app(ids),
    ).panels
    expect(Object.keys(withSelected)).toHaveLength(MAX_UI_PANELS)
    expect(withSelected.k3).toEqual({ open: true, tab: 'files' })
  })

  it('checks the panel width and drops an empty filter', () => {
    expect(normalizeUiState({ panelWidth: 0.3333333, sidebarFilter: '  ' }, app())).toEqual({
      ...emptyUiState(),
      panelWidth: 0.333,
    })
    for (const panelWidth of [0, 0.05, 0.9, Number.NaN, '0.4'])
      expect(normalizeUiState({ panelWidth }, app()).panelWidth, String(panelWidth)).toBeUndefined()
    expect(normalizeUiState({ sidebarFilter: 'x'.repeat(500) }, app()).sidebarFilter).toHaveLength(200)
  })

  it('keeps the expanded Archived groups of repos that exist, once each, and leaves out an empty list', () => {
    const ui = normalizeUiState({ archivedOpen: ['r1', 'gone', 'f1', 't1', 'r1', 7] }, app())
    expect(ui.archivedOpen).toEqual(['r1'])
    expect('archivedOpen' in normalizeUiState({ archivedOpen: ['gone'] }, app())).toBe(false)
    expect('archivedOpen' in normalizeUiState({ archivedOpen: 'r1' }, app())).toBe(false)
  })

  it('keeps the last template used in repos that exist, by name, and leaves out an empty map', () => {
    const ui = normalizeUiState({ lastTemplates: { r1: 'Review', gone: 'Fix', f1: 'Fix', t1: 'Fix' } }, app())
    expect(ui.lastTemplates).toEqual({ r1: 'Review' })
    for (const lastTemplates of [{ r1: '' }, { r1: 3 }, { r1: 'x'.repeat(61) }, { r1: 'a\nb' }, ['Review'], 'r1'])
      expect('lastTemplates' in normalizeUiState({ lastTemplates }, app()), JSON.stringify(lastTemplates)).toBe(false)
  })

  it('keeps an archived task as the selection and its panel entry', () => {
    const state = app()
    const repo = state.themes[0].items[0]
    if (repo.kind === 'repo') repo.tasks[0].archivedAt = '2026-02-01T10:00:00.000Z'
    const ui = normalizeUiState(
      { selected: { themeId: 't1', itemId: 'r1', taskId: 'k1' }, panels: { k1: { open: true, tab: 'files' } } },
      state,
    )
    expect(ui.selected).toEqual({ themeId: 't1', itemId: 'r1', taskId: 'k1' })
    expect(ui.panels).toEqual({ k1: { open: true, tab: 'files' } })
  })

  it('gives an empty state for anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 3, []]) expect(normalizeUiState(raw, app())).toEqual(emptyUiState())
  })
})
