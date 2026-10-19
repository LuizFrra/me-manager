import { useState } from 'react'
import type { Task } from '../../../shared/types'

/**
 * What the main area shows for a selected archived task, in place of the header, tabs and terminal: it has no
 * worktree or session to show. Restore recreates the worktree (and opens the task); Delete asks first.
 */
export function ArchivedTaskView(props: {
  task: Task
  repoName: string
  /** Resolves when the restore is done or failed (App shows a failure). */
  onRestore: () => Promise<void>
  onDelete: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const { task } = props
  const archivedAt = task.archivedAt ? new Date(task.archivedAt) : null
  const restore = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await props.onRestore()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="archived-task" aria-label="Archived task">
      <div className="archived-task-inner">
        <p className="archived-task-where">{props.repoName}</p>
        <h2>“{task.name}” is archived</h2>
        <p>
          Its worktree and session were removed; its branch is kept. Restoring recreates the worktree from the branch,
          where it was.
        </p>
        <dl className="archived-task-facts">
          <dt>Branch</dt>
          <dd>
            <code>{task.branch}</code>
          </dd>
          <dt>Base</dt>
          <dd>
            <code>{task.baseRef}</code>
          </dd>
          {archivedAt && !Number.isNaN(archivedAt.getTime()) && (
            <>
              <dt>Archived</dt>
              <dd>{archivedAt.toLocaleString()}</dd>
            </>
          )}
        </dl>
        {task.notes && <p className="archived-task-notes">{task.notes}</p>}
        <div className="archived-task-actions">
          <button type="button" className="primary" onClick={() => void restore()} disabled={busy}>
            {busy ? 'Restoring…' : 'Restore'}
          </button>
          <button type="button" className="danger" onClick={props.onDelete} disabled={busy}>
            Delete…
          </button>
        </div>
      </div>
    </section>
  )
}
