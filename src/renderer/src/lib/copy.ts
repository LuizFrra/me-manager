import { sessionName } from '../../../shared/naming'
import type { ResolvedTarget } from './describe'

export type CopyKind = 'branch' | 'path' | 'attach'

/** Something about the selected task or folder that can be copied to the clipboard. */
export interface CopyEntry {
  kind: CopyKind
  /** The action's name: "Copy branch name". */
  label: string
  /** For the confirmation: "Copied branch name". */
  what: string
  text: string
}

/** The string as one shell word: unchanged when it is safe as is, single-quoted otherwise. */
export function shellQuote(s: string): string {
  return /^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** The command that attaches a terminal to the target's tmux session, outside the app. */
export function attachCommand(socket: string, session: string): string {
  return `tmux -L ${shellQuote(socket)} attach -t ${shellQuote(session)}`
}

/**
 * What can be copied for a target: a task's branch, worktree path and attach command, or a folder's path and
 * attach command. The attach command needs the tmux socket name, so it is left out until that is known.
 */
export function copyEntries({ theme, item, task }: ResolvedTarget, socket: string | null): CopyEntry[] {
  const entries: CopyEntry[] = []
  if (task) {
    entries.push(
      { kind: 'branch', label: 'Copy branch name', what: 'branch name', text: task.branch },
      { kind: 'path', label: 'Copy worktree path', what: 'worktree path', text: task.worktreePath },
    )
  } else if (item.kind === 'folder') {
    entries.push({ kind: 'path', label: 'Copy folder path', what: 'folder path', text: item.path })
  } else {
    return entries // a repo without a task has nothing to copy
  }
  if (socket !== null) {
    entries.push({
      kind: 'attach',
      label: 'Copy attach command',

      what: 'attach command',
      text: attachCommand(socket, sessionName(theme.slug, item.slug, task?.slug)),
    })
  }
  return entries
}
