import type { ClaudeActivity } from '../../shared/types'

/**
 * Best-effort detection of what Claude Code is doing in a tmux window, from two cheap signals:
 *
 * 1. `#{window_activity}`, the last time the window printed anything (Unix seconds). Claude Code animates a
 *    spinner while it works, so output within the last BUSY_WINDOW_S seconds means **busy**.
 * 2. Otherwise, the bottom of the visible screen (`capture-pane -p`). Claude Code draws its dialogs where the
 *    prompt input normally is, so a choice menu or a "Do you want to …?" question there, with no prompt input
 *    below it, means **waiting** for the user (a permission prompt, AskUserQuestion, plan approval, trust or
 *    login dialog). Anything else, typically the empty prompt input, means **idle**.
 *
 * This is a heuristic on another program's screen. It can be wrong for a moment (typing in the terminal counts as
 * output, a redraw after a resize or focus change looks like work) and may need new markers when Claude Code's
 * TUI changes. Markers, as Claude Code 2.1 draws them:
 *
 *     Do you want to proceed?                         <- QUESTION
 *     ❯ 1. Yes                                        <- SELECTED_OPTION (the pointer is figures.pointer, U+276F)
 *       2. Yes, and don't ask again for …             <- OPTION
 *       3. No, and tell Claude what to do differently (esc)
 *     Enter to select · ↑/↓ to navigate · Esc to cancel   <- SELECT_FOOTER
 *
 *     ────────────────────────────────                <- RULE: the prompt input's border, right above…
 *     ❯ draft text                                    <- INPUT_LINE: …the input line (`>` in older versions)
 */

/** Output this recent (in whole seconds, the resolution tmux reports) means Claude is working. */
export const BUSY_WINDOW_S = 3
/** Claude Code draws its prompt input or dialog at the bottom; only the last non-blank lines are looked at. */
export const PANE_TAIL_LINES = 15

/** Box-drawing borders (older versions box the prompt and dialogs) and surrounding spaces. */
const EDGES = /^[\s│┃║]+|[\s│┃║]+$/g
const SELECTED_OPTION = /^[❯›▸>]\s*\d{1,2}[.)]\s+\S/
const OPTION = /^\d{1,2}[.)]\s+\S/
const QUESTION = /^(?:Do you want to|Would you like to)\b.*\?$/
const SELECT_FOOTER = /\bEnter to (?:select|confirm)\b|\bEsc to cancel\b/
const RULE = /^[╭╰┌└]?[─━═╌]{8,}[╮╯┐┘]?$/
/** The prompt input line: a pointer, then nothing or a draft that isn't a numbered option. */
const INPUT_LINE = /^[❯>](?:\s*$|\s+(?!\d{1,2}[.)]\s))/

export function isRecentlyActive(activitySec: number, nowMs: number): boolean {
  return Math.floor(nowMs / 1000) - activitySec <= BUSY_WINDOW_S
}

/** The last PANE_TAIL_LINES non-blank lines, without box borders. */
export function paneTail(pane: string): string[] {
  return pane
    .split(/\r?\n/)
    .map((line) => line.replace(EDGES, ''))
    .filter((line) => line !== '')
    .slice(-PANE_TAIL_LINES)
}

/** True when the bottom of the screen shows a Claude Code question or choice menu rather than its prompt input. */
export function looksWaiting(pane: string): boolean {
  const lines = paneTail(pane)
  let promptAt = -1
  let inputAt = -1
  lines.forEach((line, i) => {
    // A selected option with another option close by (options may have a description line under them).
    const isMenu =
      SELECTED_OPTION.test(line) && lines.slice(Math.max(0, i - 3), i + 4).some((l) => l !== line && OPTION.test(l))
    if (isMenu || QUESTION.test(line) || SELECT_FOOTER.test(line)) promptAt = i
    if (i > 0 && RULE.test(lines[i - 1]) && INPUT_LINE.test(line)) inputAt = i
  })
  // An input box below the last question means the question is old output (a reply, an earlier message).
  return promptAt > inputAt
}

export interface ActivityInput {
  /** `#{window_activity}` of the session's `claude` window, in Unix seconds. */
  activitySec: number
  nowMs: number
  /** The window's visible text; not needed (and not captured) when the window is busy. */
  pane?: string | null
}

export function classifyActivity({ activitySec, nowMs, pane }: ActivityInput): ClaudeActivity {
  if (isRecentlyActive(activitySec, nowMs)) return 'busy'
  return pane && looksWaiting(pane) ? 'waiting' : 'idle'
}
