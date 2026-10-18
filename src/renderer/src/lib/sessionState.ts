import type { ClaudeActivity, LiveStatus } from '../../../shared/types'

/** A task's or folder's session as the sidebar dot and the header show it. */
export type SessionState = ClaudeActivity | 'running' | 'none' | 'missing'

/** `running`: a session whose claude window is gone (only shell tabs left), so there is no activity to show. */
export function sessionState(status: LiveStatus, id: string): SessionState {
  if (status.missing.includes(id)) return 'missing'
  if (!status.running.includes(id)) return 'none'
  return status.activity[id] ?? 'running'
}

export const SESSION_STATE_INFO: Record<SessionState, { glyph: string; label: string; title: string }> = {
  busy: { glyph: '●', label: 'Working', title: 'Claude is working' },
  waiting: {
    glyph: '●',
    label: 'Waiting for you',
    title: 'Waiting for you: Claude asked a question or for permission',
  },
  idle: { glyph: '●', label: 'Idle', title: 'Claude is idle' },
  running: { glyph: '●', label: 'Running', title: 'Session running' },
  none: { glyph: '○', label: 'No session', title: 'No session' },
  missing: { glyph: '⚠', label: 'Path missing', title: 'Path missing' },
}
