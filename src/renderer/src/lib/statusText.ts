import { SESSION_STATE_INFO, type SessionState } from './sessionState'

/** The longest last-commit subject shown before it is cut with "…" (CSS also ellipsizes a narrow bar). */
export const STATUS_SUBJECT_MAX = 60

/** `text`, cut to `max` characters with a trailing "…". */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** The bar's text for a session: Claude's activity when known, otherwise what the session is doing. */
export function claudeStateText(session: SessionState): string {
  switch (session) {
    case 'busy':
      return 'Claude busy'
    case 'waiting':
      return 'Claude waiting'
    case 'idle':
      return 'Claude idle'
    default:
      return SESSION_STATE_INFO[session].label
  }
}
