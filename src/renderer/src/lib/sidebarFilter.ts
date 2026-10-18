import type { AppState } from '../../../shared/types'

/** What the sidebar shows while a filter is active, as sets of theme, item (repo or folder) and task ids. */
export interface SidebarFilter {
  themes: ReadonlySet<string>
  items: ReadonlySet<string>
  tasks: ReadonlySet<string>
}

/**
 * Narrows the sidebar to the themes, repos, folders and tasks whose name contains `query` (case-insensitive),
 * plus their ancestors, so every match keeps its place in the tree. A matching theme or repo also keeps its
 * contents: filtering by a theme or repo name shows what is inside it.
 * Returns null for a blank query: no filter, show everything.
 */
export function filterSidebar(state: AppState, query: string): SidebarFilter | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const matches = (name: string): boolean => name.toLowerCase().includes(q)
  const themes = new Set<string>()
  const items = new Set<string>()
  const tasks = new Set<string>()
  for (const theme of state.themes) {
    const themeHit = matches(theme.name)
    for (const item of theme.items) {
      const itemHit = themeHit || matches(item.name)
      let show = itemHit
      if (item.kind === 'repo')
        for (const task of item.tasks)
          if (itemHit || matches(task.name)) {
            tasks.add(task.id)
            show = true
          }
      if (show) items.add(item.id)
    }
    if (themeHit || theme.items.some((i) => items.has(i.id))) themes.add(theme.id)
  }
  return { themes, items, tasks }
}
