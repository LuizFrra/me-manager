export type PanelTab = 'files' | 'changes'

/** What the side panel shows for one target. */
export interface PanelState {
  tab: PanelTab
  selected?: string
  mdMode: 'view' | 'raw'
  /** Files visited before following Markdown links, most recent last. */
  history: string[]
}

export interface PanelEntry extends PanelState {
  open: boolean
}

export const DEFAULT_PANEL: PanelEntry = { open: false, tab: 'files', mdMode: 'view', history: [] }

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
