import { slugify } from '../../../shared/naming'
import { isArchived, type AppState } from '../../../shared/types'

/** The home screen's composer: start a task from a prompt, Claude-style. */

export interface RepoChoice {
  themeId: string
  repoId: string
  label: string
}

/** Every repository a task can start in, theme by theme, as "Theme › repo". */
export function repoChoices(state: AppState): RepoChoice[] {
  return state.themes.flatMap((theme) =>
    theme.items
      .filter((item) => item.kind === 'repo')
      .map((item) => ({ themeId: theme.id, repoId: item.id, label: `${theme.name} › ${item.name}` })),
  )
}

/** Where the composer starts: the repository of the newest active task, else the first one; null without any. */
export function defaultRepo(state: AppState): { themeId: string; repoId: string } | null {
  let best: { themeId: string; repoId: string; time: number } | null = null
  for (const theme of state.themes)
    for (const item of theme.items) {
      if (item.kind !== 'repo') continue
      for (const task of item.tasks) {
        const time = Date.parse(task.createdAt) || 0
        if (!isArchived(task) && (!best || time > best.time)) best = { themeId: theme.id, repoId: item.id, time }
      }
    }
  if (best) return { themeId: best.themeId, repoId: best.repoId }
  const first = repoChoices(state)[0]
  return first ? { themeId: first.themeId, repoId: first.repoId } : null
}

const MAX_NAME = 40
const MAX_WORDS = 6

/**
 * A task name for `prompt`: up to six words of its first line, without punctuation, cut at a word boundary within
 * 40 characters; "task" when no word survives as a slug. A number is added while its slug is in `taken`.
 */
export function taskNameFromPrompt(prompt: string, taken: readonly string[]): string {
  const words = (prompt.trim().split('\n')[0] ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((w) => slugify(w) !== '')
    .slice(0, MAX_WORDS)
  let base = ''
  for (const word of words) {
    const next = base ? `${base} ${word}` : word
    if (next.length > MAX_NAME) break
    base = next
  }
  if (!base) base = 'task'
  const used = new Set(taken)
  let name = base
  for (let n = 2; used.has(slugify(name)); n++) name = `${base} ${n}`
  return name
}

/** "Good morning" (5–11 h), "Good afternoon" (12–17 h) or "Good evening". */
export function greeting(now: Date): string {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}
