/** How far back a snapshot reaches into a pane's history. */
export const HISTORY_LINES = 10_000

/** A pane's terminal state, as tmux holds it (rows and columns are 0-based). */
export interface PaneState {
  pane: string
  alternate: boolean
  /** Where the cursor was when the program switched to the alternate screen (UNSET when it never did). */
  altSavedX: number
  altSavedY: number
  cursorVisible: boolean
  cursorX: number
  /** From the top of the screen, even in origin mode. */
  cursorY: number
  insert: boolean
  keypadCursor: boolean
  keypad: boolean
  mouseStandard: boolean
  mouseButton: boolean
  /** Every motion reported (1003). */
  mouseAll: boolean
  mouseSgr: boolean
  mouseUtf8: boolean
  origin: boolean
  scrollTop: number
  scrollBottom: number
  wrap: boolean
  height: number
}

/** What the terminal needs to show a pane: its state, the normal screen (history first) and the alternate one. */
export interface Snapshot {
  state: PaneState
  normal: string[]
  alternate: string[] | null
}

/** tmux's alternate_saved_x/y when nothing was saved. */
const UNSET = 4294967295

type Field = { [K in keyof PaneState]: PaneState[K] extends boolean ? K : never }[keyof PaneState]
type NumberField = Exclude<keyof PaneState, Field | 'pane'>

/** The state line's fields, in order: the tmux format and the PaneState key it fills. */
const FIELDS: [string, 'pane' | Field | NumberField, 'pane' | 'flag' | 'number'][] = [
  ['pane_id', 'pane', 'pane'],
  ['alternate_on', 'alternate', 'flag'],
  ['alternate_saved_x', 'altSavedX', 'number'],
  ['alternate_saved_y', 'altSavedY', 'number'],
  ['cursor_flag', 'cursorVisible', 'flag'],
  ['cursor_x', 'cursorX', 'number'],
  ['cursor_y', 'cursorY', 'number'],
  ['insert_flag', 'insert', 'flag'],
  ['keypad_cursor_flag', 'keypadCursor', 'flag'],
  ['keypad_flag', 'keypad', 'flag'],
  ['mouse_standard_flag', 'mouseStandard', 'flag'],
  ['mouse_button_flag', 'mouseButton', 'flag'],
  // Not mouse_any_flag: that one is set by any of the mouse modes.
  ['mouse_all_flag', 'mouseAll', 'flag'],
  ['mouse_sgr_flag', 'mouseSgr', 'flag'],
  ['mouse_utf8_flag', 'mouseUtf8', 'flag'],
  ['origin_flag', 'origin', 'flag'],
  ['scroll_region_upper', 'scrollTop', 'number'],
  ['scroll_region_lower', 'scrollBottom', 'number'],
  ['wrap_flag', 'wrap', 'flag'],
  ['pane_height', 'height', 'number'],
]

const STATE_FORMAT = FIELDS.map(([format]) => `#{${format}}`).join(' ')

/**
 * One input line for a control client: three commands, answered by three replies in this order (SNAPSHOT_REPLIES)
 * when they all succeed. tmux runs them as a group: when one fails, its %error is the line's last reply.
 */
export function snapshotCommand(target: string): string {
  // The line goes through tmux's command parser: anything that ends a word, a command or the line is refused.
  if (!target || /['"\s;\\]/.test(target)) throw new Error(`Bad tmux target: ${JSON.stringify(target)}`)
  // -e keeps colours as SGR escapes; -J joins wrapped lines (xterm re-wraps them at its own width). The second
  // capture is the saved normal screen while a program is on the alternate one, and nothing otherwise (-q).
  return [
    `capture-pane -p -e -J -S -${HISTORY_LINES} -t ${target}`,
    `capture-pane -p -e -J -a -q -t ${target}`,
    `display-message -p -t ${target} '${STATE_FORMAT}'`,
  ].join(' ; ')
}

export const SNAPSHOT_REPLIES = 3

function parseState(line: string | undefined): PaneState | null {
  const words = line?.split(' ') ?? []
  if (words.length !== FIELDS.length) return null
  const state: Record<string, string | boolean | number> = {}
  for (const [i, [, key, kind]] of FIELDS.entries()) {
    const word = words[i] as string
    if (kind === 'pane') {
      if (!/^%\d+$/.test(word)) return null
      state[key] = word
    } else if (kind === 'flag') {
      if (word !== '0' && word !== '1') return null
      state[key] = word === '1'
    } else {
      if (!/^\d+$/.test(word)) return null
      state[key] = Number(word)
    }
  }
  return state as unknown as PaneState
}

/** The snapshot from those replies' lines (in order), or null when the state line is malformed. */
export function parseSnapshot(replies: string[][]): Snapshot | null {
  const [current = [], saved = [], stateLines = []] = replies
  const state = parseState(stateLines[0])
  if (!state) return null
  if (!state.alternate) return { state, normal: current, alternate: null }
  // On the alternate screen tmux's grid still holds the history, above the alternate screen: the last screenful
  // is that screen, and the rest is history that belongs above the saved normal screen. When -J joined some of
  // the alternate screen's rows this takes a few history lines too, which only scroll off xterm's alternate
  // screen (it has no scrollback), so the screen still shows right.
  const split = Math.max(0, current.length - state.height)
  return { state, normal: [...current.slice(0, split), ...saved], alternate: current.slice(split) }
}

const cup = (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`

/** What to write to xterm so it shows the pane as tmux holds it. */
export function snapshotData(s: Snapshot): string {
  const { state } = s
  // No newline after the last line: it would scroll one row. Lines beyond the screen go to xterm's scrollback.
  let out = `\x1bc${s.normal.join('\r\n')}\x1b[0m`
  if (s.alternate) {
    // 1049h saves the cursor (restored when the program leaves) but doesn't move it, so home it before writing.
    if (state.altSavedX !== UNSET && state.altSavedY !== UNSET) out += cup(state.altSavedX, state.altSavedY)
    out += `\x1b[?1049h\x1b[H${s.alternate.join('\r\n')}\x1b[0m`
  }
  // Setting the scroll region homes the cursor, so it goes before the final cursor position.
  if (state.scrollTop !== 0 || state.scrollBottom !== state.height - 1)
    out += `\x1b[${state.scrollTop + 1};${state.scrollBottom + 1}r`
  if (state.origin) out += '\x1b[?6h'
  if (!state.wrap) out += '\x1b[?7l'
  if (state.insert) out += '\x1b[4h'
  if (state.keypad) out += '\x1b='
  if (state.keypadCursor) out += '\x1b[?1h'
  if (state.mouseStandard) out += '\x1b[?1000h'
  if (state.mouseButton) out += '\x1b[?1002h'
  if (state.mouseAll) out += '\x1b[?1003h'
  if (state.mouseSgr) out += '\x1b[?1006h'
  if (state.mouseUtf8) out += '\x1b[?1005h'
  if (!state.cursorVisible) out += '\x1b[?25l'
  // tmux has no format for bracketed paste, so the terminal always brackets pastes; they reach the pane through
  // `paste-buffer -p`, which keeps the brackets only when the program asked for them.
  out += '\x1b[?2004h'
  // In origin mode the cursor's row counts from the top of the scroll region; tmux's cursor_y doesn't.
  return out + cup(state.cursorX, state.origin ? state.cursorY - state.scrollTop : state.cursorY)
}
