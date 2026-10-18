import type { PanelTabName } from '../../../shared/types'

export type PanelTab = PanelTabName

/** The Search tab's query and toggles. */
export interface SearchState {
  query: string
  caseSensitive: boolean
  regex: boolean
}

export const DEFAULT_SEARCH: SearchState = { query: '', caseSensitive: false, regex: false }

/** What the side panel shows for one target. */
export interface PanelState {
  tab: PanelTab
  selected?: string
  /** A line of the selected file to scroll to and highlight (a search result); cleared when another file opens. */
  line?: number
  search: SearchState
  mdMode: 'view' | 'raw'
  /** Files visited before following Markdown links, most recent last. */
  history: string[]
}

export interface PanelEntry extends PanelState {
  open: boolean
}

export const DEFAULT_PANEL: PanelEntry = {
  open: false,
  tab: 'files',
  mdMode: 'view',
  history: [],
  search: DEFAULT_SEARCH,
}

/** Panel width as a fraction of the workspace; CSS clamps it to 280px … 70%. */
export const DEFAULT_PANEL_FRACTION = 0.4
export const MAX_PANEL_FRACTION = 0.7
export const MIN_PANEL_PX = 280
const WIDTH_KEY = 'me-manager.panelWidth'

export function clampFraction(fraction: number, containerPx?: number): number {
  const min = containerPx ? Math.min(MIN_PANEL_PX / containerPx, MAX_PANEL_FRACTION) : 0.1
  if (!Number.isFinite(fraction)) return DEFAULT_PANEL_FRACTION
  return Math.min(MAX_PANEL_FRACTION, Math.max(min, fraction))
}

export function loadPanelFraction(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value > 0 ? clampFraction(value) : DEFAULT_PANEL_FRACTION
  } catch {
    return DEFAULT_PANEL_FRACTION
  }
}

export function savePanelFraction(fraction: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(fraction * 1000) / 1000))
  } catch {
    // storage may be unavailable; the width just isn't remembered
  }
}
