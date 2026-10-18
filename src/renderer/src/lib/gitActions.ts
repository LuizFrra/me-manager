/** The git actions a task's header and the palette offer; one runs at a time per task. */
export type GitActionKind = 'commit' | 'push' | 'pr'

/** The running action's button label. */
export const GIT_ACTION_BUSY: Record<GitActionKind, string> = {
  commit: 'Committing…',
  push: 'Pushing…',
  pr: 'Opening…',
}
