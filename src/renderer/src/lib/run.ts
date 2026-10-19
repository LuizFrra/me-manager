import { RUN_WINDOW } from '../../../shared/runCommand'
import type { TabInfo } from '../../../shared/types'

/** The run tab of the selected task or folder: none yet, its command running, or exited (the tab kept open). */
export type RunState = 'none' | 'running' | 'stopped'

/** From the tabs the app already polls: the tab named `run`, and whether tmux reports its pane dead. */
export function runState(tabs: readonly TabInfo[]): RunState {
  const tab = tabs.find((t) => t.name === RUN_WINDOW)
  if (!tab) return 'none'
  return tab.dead ? 'stopped' : 'running'
}

export const RUN_STATE_INFO: Record<Exclude<RunState, 'none'>, { glyph: string; label: string; title: string }> = {
  running: { glyph: '▶', label: 'running', title: 'The run command is running in the “run” tab' },
  stopped: { glyph: '■', label: 'stopped', title: 'The run command exited; its output is in the “run” tab' },
}

/** Longest command shown whole in a button or the palette; the full one is in the tooltip. */
export const RUN_LABEL_MAX = 40

export const runLabel = (command: string): string =>
  command.length > RUN_LABEL_MAX ? `${command.slice(0, RUN_LABEL_MAX - 1)}…` : command
