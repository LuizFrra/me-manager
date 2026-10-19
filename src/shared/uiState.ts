import { targetKey } from './naming'
import { templateNameError } from './templates'
import type { AppState, PanelTabName, Target, UiPanelState, UiState } from './types'

/** Side panel entries kept at most: the most recently changed ones (and always the selected target's). */
export const MAX_UI_PANELS = 200
/** Collapsed ids kept at most. */
const MAX_COLLAPSED = 1_000
/** The longest sidebar filter and selected-file path remembered. */
const MAX_FILTER = 200
const MAX_PATH = 4_096
const MIN_WIDTH = 0.1
const MAX_WIDTH = 0.7

const TABS: readonly PanelTabName[] = ['files', 'changes', 'search']

export const emptyUiState = (): UiState => ({ version: 1, collapsed: [], panels: {} })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every target in the app, by targetKey, with whether it is a repo task. */
function knownTargets(app: AppState): Map<string, { target: Target; task: boolean }> {
  const known = new Map<string, { target: Target; task: boolean }>()
  for (const theme of app.themes) {
    for (const item of theme.items) {
      if (item.kind === 'folder') {
        known.set(item.id, { target: { themeId: theme.id, itemId: item.id }, task: false })
        continue
      }
      for (const task of item.tasks)
        known.set(task.id, { target: { themeId: theme.id, itemId: item.id, taskId: task.id }, task: true })
    }
  }
  return known
}

/** The target as the app has it now, or undefined when it no longer exists (or never did). */
function existingTarget(raw: unknown, known: ReturnType<typeof knownTargets>): Target | undefined {
  if (!isRecord(raw) || typeof raw.themeId !== 'string' || typeof raw.itemId !== 'string') return undefined
  if (raw.taskId !== undefined && typeof raw.taskId !== 'string') return undefined
  const entry = known.get(targetKey(raw as unknown as Target))
  if (!entry) return undefined
  const t = entry.target
  return t.themeId === raw.themeId && t.itemId === raw.itemId && t.taskId === raw.taskId ? { ...t } : undefined
}

function panelEntry(raw: unknown, isTask: boolean): UiPanelState | undefined {
  if (!isRecord(raw)) return undefined
  const tab = TABS.includes(raw.tab as PanelTabName) ? (raw.tab as PanelTabName) : 'files'
  const entry: UiPanelState = { open: raw.open === true, tab: tab === 'changes' && !isTask ? 'files' : tab }
  const selected = raw.selected
  if (typeof selected === 'string' && selected !== '' && selected.length <= MAX_PATH && !selected.includes('\0'))
    entry.selected = selected
  // A closed panel on Files with nothing selected is what every target starts with: nothing to remember.
  return entry.open || entry.tab !== 'files' || entry.selected ? entry : undefined
}

/**
 * Makes UI state read from disk or sent by the renderer safe to use against `app`: unknown fields and wrong types
 * are dropped, targets (the selection, panel entries, collapsed ids, expanded Archived groups, last templates) that
 * no longer exist are dropped, sizes are capped (at most MAX_UI_PANELS panel entries, the most recent ones) and the
 * panel width is checked. Pure.
 */
export function normalizeUiState(raw: unknown, app: AppState): UiState {
  const out = emptyUiState()
  if (!isRecord(raw)) return out
  const known = knownTargets(app)

  const selected = existingTarget(raw.selected, known)
  if (selected) out.selected = selected

  const repoIds = new Set<string>()
  for (const theme of app.themes) for (const item of theme.items) if (item.kind === 'repo') repoIds.add(item.id)
  const ids = new Set([...app.themes.map((t) => t.id), ...repoIds])
  /** The known ids in `list`, once each, at most MAX_COLLAPSED. */
  const knownIds = (list: unknown, known: ReadonlySet<string>): string[] =>
    Array.isArray(list)
      ? [...new Set(list.filter((id): id is string => typeof id === 'string' && known.has(id)))].slice(0, MAX_COLLAPSED)
      : []
  out.collapsed = knownIds(raw.collapsed, ids)
  const archivedOpen = knownIds(raw.archivedOpen, repoIds)
  if (archivedOpen.length > 0) out.archivedOpen = archivedOpen

  if (isRecord(raw.panels)) {
    const entries: [string, UiPanelState][] = []
    for (const [key, value] of Object.entries(raw.panels)) {
      const target = known.get(key)
      const entry = target && panelEntry(value, target.task)
      if (entry) entries.push([key, entry])
    }
    // Keep the most recent ones (last), and the selected target's wherever it is.
    const selectedKey = selected ? targetKey(selected) : undefined
    const recent = entries.slice(-MAX_UI_PANELS)
    const own = entries.find(([key]) => key === selectedKey)
    if (own && !recent.includes(own)) recent.splice(0, 1, own)
    out.panels = Object.fromEntries(recent)
  }

  const width = raw.panelWidth
  if (typeof width === 'number' && Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH)
    out.panelWidth = Math.round(width * 1000) / 1000

  if (typeof raw.sidebarFilter === 'string' && raw.sidebarFilter.trim() !== '')
    out.sidebarFilter = raw.sidebarFilter.slice(0, MAX_FILTER)

  if (raw.sidebarCollapsed === true) out.sidebarCollapsed = true

  if (isRecord(raw.lastTemplates)) {
    const lastTemplates = Object.entries(raw.lastTemplates).filter(
      (entry): entry is [string, string] =>
        repoIds.has(entry[0]) && typeof entry[1] === 'string' && !templateNameError(entry[1]),
    )
    if (lastTemplates.length > 0) out.lastTemplates = Object.fromEntries(lastTemplates)
  }

  return out
}
