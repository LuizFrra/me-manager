import type { AppState, LiveStatus, Target } from '../../../shared/types'
import { allTargets, type TargetEntry } from './targets'
import { targetKey } from '../../../shared/naming'

/** The tasks and folders whose Claude is waiting for the user (a question or a permission), in sidebar order. */
export function waitingTargets(state: AppState, status: LiveStatus): TargetEntry[] {
  return allTargets(state).filter((e) => status.activity[targetKey(e.target)] === 'waiting')
}

/**
 * The window's title: the selected task or folder (its last label part), and how many sessions wait for the user,
 * as "(2) fix-login — me-manager", so the taskbar shows both.
 */
export function windowTitle(state: AppState, status: LiveStatus, selected: Target | null): string {
  const waiting = waitingTargets(state, status).length
  const entry = selected ? allTargets(state).find((e) => targetKey(e.target) === targetKey(selected)) : undefined
  const name = entry?.label.split(' › ').at(-1)
  return `${waiting > 0 ? `(${waiting}) ` : ''}${name ? `${name} — ` : ''}me-manager`
}

/**
 * Ids whose Claude stopped working between two status polls: busy before, idle or waiting now. The sidebar marks
 * them until they are opened, like unread chats.
 */
export function finishedIds(prev: LiveStatus['activity'], next: LiveStatus['activity']): string[] {
  return Object.keys(prev).filter((id) => prev[id] === 'busy' && (next[id] === 'idle' || next[id] === 'waiting'))
}
