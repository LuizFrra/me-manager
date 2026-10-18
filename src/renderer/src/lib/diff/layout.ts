/** How DiffView lays a diff out: one column (`unified`) or old and new side by side (`split`). */
export type DiffLayout = 'unified' | 'split'

/** Until the user picks a layout, a panel wider than this (in CSS px) shows diffs side by side. */
export const SPLIT_MIN_WIDTH = 700

const KEY = 'me-manager.diffLayout'

/** The layout for a panel this wide, when the user hasn't picked one. */
export const autoDiffLayout = (widthPx: number): DiffLayout => (widthPx > SPLIT_MIN_WIDTH ? 'split' : 'unified')

/** The layout the user picked last (one choice for every task and folder), or null if they never picked one. */
export function loadDiffLayout(): DiffLayout | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'unified' || raw === 'split' ? raw : null
  } catch {
    return null
  }
}

export function saveDiffLayout(layout: DiffLayout): void {
  try {
    localStorage.setItem(KEY, layout)
  } catch {
    // storage may be unavailable; the choice just isn't remembered
  }
}
