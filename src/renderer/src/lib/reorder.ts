import { isArchived, type AppState, type MeManagerApi } from '../../../shared/types'
import { clampIndex, moveActiveTask, moveEntry } from '../../../shared/reorder'

/**
 * What the sidebar can move: a theme among the themes, a repo or folder within its theme, an active task within its
 * repo. Never across: an item's worktree paths hold its theme's slug, a task's its repo's.
 */
export type MoveEntry =
  | { kind: 'theme'; themeId: string }
  | { kind: 'item'; themeId: string; itemId: string }
  | { kind: 'task'; themeId: string; repoId: string; taskId: string }

/** A move of an entry to index `toIndex` among its siblings, as main's moveTheme, moveItem and moveTask take it. */
export type Move = MoveEntry & { toIndex: number }

/** Where a dragged row goes, relative to the row it is dropped on. */
export type DropSide = 'before' | 'after'

/** The entry's own id. */
export const entryId = (entry: MoveEntry): string =>
  entry.kind === 'theme' ? entry.themeId : entry.kind === 'item' ? entry.itemId : entry.taskId

/** What the entry moves within: its theme for an item, its repo for a task; '' for a theme. */
export const entryParent = (entry: MoveEntry): string =>
  entry.kind === 'theme' ? '' : entry.kind === 'item' ? entry.themeId : entry.repoId

/** The entry's siblings (itself included) in order, as the sidebar lists them; null when it is gone. */
function siblings(state: AppState, entry: MoveEntry): { id: string; name: string }[] | null {
  if (entry.kind === 'theme') return state.themes
  const theme = state.themes.find((t) => t.id === entry.themeId)
  if (!theme) return null
  if (entry.kind === 'item') return theme.items
  const repo = theme.items.find((i) => i.id === entry.repoId)
  return repo?.kind === 'repo' ? repo.tasks.filter((t) => !isArchived(t)) : null
}

/** The ids of the entry's siblings, itself included, in order; [] when it is gone. */
export const siblingIds = (state: AppState, entry: MoveEntry): string[] =>
  siblings(state, entry)?.map((s) => s.id) ?? []

/**
 * `state` with the move applied, as main will apply it (see moveTheme, moveItem and moveTask): for showing it at
 * once. `state` itself when nothing moves, or the entry isn't there (an archived task is not).
 */
export function applyMove(state: AppState, move: Move): AppState {
  const ids = siblingIds(state, move)
  const from = ids.indexOf(entryId(move))
  if (from === -1 || clampIndex(move.toIndex, ids.length) === from) return state
  if (move.kind === 'theme') return { ...state, themes: [...moveEntry(state.themes, from, move.toIndex)] }
  return {
    ...state,
    themes: state.themes.map((theme) => {
      if (theme.id !== move.themeId) return theme
      if (move.kind === 'item') return { ...theme, items: [...moveEntry(theme.items, from, move.toIndex)] }
      return {
        ...theme,
        items: theme.items.map((item) =>
          item.id === move.repoId && item.kind === 'repo'
            ? { ...item, tasks: [...moveActiveTask(item.tasks, move.taskId, move.toIndex)] }
            : item,
        ),
      }
    }),
  }
}

/** The move of `entry` one step up (-1) or down (1) among its siblings; null when it is at that end, or gone. */
export function stepMove(state: AppState, entry: MoveEntry, step: -1 | 1): Move | null {
  const ids = siblingIds(state, entry)
  const from = ids.indexOf(entryId(entry))
  if (from === -1 || clampIndex(from + step, ids.length) === from) return null
  return { ...entry, toIndex: from + step }
}

/**
 * The index the dragged entry moves to when dropped `side` of the row of `targetId`, both in `ids` (their
 * siblings, in order); null when that leaves it where it is, or either is not in `ids`.
 */
export function dropIndex(ids: readonly string[], draggedId: string, targetId: string, side: DropSide): number | null {
  const from = ids.indexOf(draggedId)
  const target = ids.indexOf(targetId)
  if (from === -1 || target === -1) return null
  const gap = target + (side === 'after' ? 1 : 0) // the gap between rows it is dropped into
  const to = gap > from ? gap - 1 : gap
  return to === from ? null : to
}

/** What a screen reader hears once `entry` has moved: "Moved fix-login to position 2 of 5". Null when it is gone. */
export function moveAnnouncement(state: AppState, entry: MoveEntry): string | null {
  const list = siblings(state, entry) ?? []
  const index = list.findIndex((s) => s.id === entryId(entry))
  return index === -1 ? null : `Moved ${list[index].name} to position ${index + 1} of ${list.length}`
}

/** Sends the move to main. */
export function sendMove(
  api: Pick<MeManagerApi, 'moveTheme' | 'moveItem' | 'moveTask'>,
  move: Move,
): Promise<AppState> {
  if (move.kind === 'theme') return api.moveTheme(move.themeId, move.toIndex)
  if (move.kind === 'item') return api.moveItem(move.themeId, move.itemId, move.toIndex)
  return api.moveTask(move.themeId, move.repoId, move.taskId, move.toIndex)
}
