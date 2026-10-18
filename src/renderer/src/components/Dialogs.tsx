import { useId, useRef, useState } from 'react'
import { MAX_TASK_NOTES, type UnsavedWork } from '../../../shared/types'
import { isModEnter, MOD_ENTER_LABEL } from '../lib/shortcuts'

/** Asks for a name: a new theme or task, or a new display name for one (`initial` prefills it). */
export function NameDialog(props: {
  title: string
  placeholder: string
  /** The current name, when renaming. Submitting it unchanged is disabled. */
  initial?: string
  /** The submit button's label; "Create" by default. */
  submitLabel?: string
  /** A short explanation shown under the field. */
  note?: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(props.initial ?? '')
  const [busy, setBusy] = useState(false)
  const unchanged = props.initial !== undefined && name.trim() === props.initial
  const noteId = useId()
  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-label={props.title}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim() || unchanged) return
          setBusy(true)
          try {
            await props.onSubmit(name.trim())
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2>{props.title}</h2>
        <input
          autoFocus
          aria-label="Name"
          aria-describedby={props.note ? noteId : undefined}
          placeholder={props.placeholder}
          value={name}
          onFocus={(e) => props.initial !== undefined && e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
        />
        {props.note && (
          <p id={noteId} className="dialog-note">
            {props.note}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || unchanged}>
            {busy ? 'Working…' : (props.submitLabel ?? 'Create')}
          </button>
        </div>
      </form>
    </div>
  )
}

export function RemoveTaskDialog(props: {
  taskName: string
  work: UnsavedWork
  onConfirm: (deleteBranch: boolean) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  // The ref blocks a second click that lands before React re-renders with the buttons disabled.
  const busyRef = useRef(false)
  const { uncommittedFiles, unpushedCommits, warning } = props.work
  const hasChanges = uncommittedFiles.length > 0 || unpushedCommits.length > 0
  const confirm = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onConfirm(deleteBranch)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-label={`Remove ${props.taskName}`}>
        <h2>Remove “{props.taskName}”?</h2>
        {warning && (
          <div className="dialog-warning" role="alert">
            <strong>Could not fully check this task for unsaved work.</strong>
            <p>{warning}</p>
          </div>
        )}
        {hasChanges && <p>This task has work that will be lost:</p>}
        {uncommittedFiles.length > 0 && (
          <>
            <h3>{uncommittedFiles.length} uncommitted file(s)</h3>
            <ul>
              {uncommittedFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        )}
        {unpushedCommits.length > 0 && (
          <>
            <h3>{unpushedCommits.length} unpushed commit(s)</h3>
            <ul>
              {unpushedCommits.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Also delete the branch
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Removing…' : 'Remove anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Edits a task's free-text notes. Mod+Enter saves, Esc cancels; saving an empty text removes the notes. */
export function NotesDialog(props: {
  taskName: string
  initial: string
  onSave: (notes: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [notes, setNotes] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const counterId = useId()
  const unchanged = notes.trim() === props.initial.trim()
  const save = async (): Promise<void> => {
    if (busyRef.current || unchanged) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onSave(notes)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <div className="overlay">
      <form
        className="dialog notes-dialog"
        role="dialog"
        aria-label={`Notes for ${props.taskName}`}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>Notes for “{props.taskName}”</h2>
        <textarea
          autoFocus
          aria-label="Notes"
          aria-describedby={counterId}
          rows={8}
          maxLength={MAX_TASK_NOTES}
          placeholder="What is this task about? What's left to do?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              props.onCancel()
            } else if (isModEnter(e.nativeEvent)) {
              e.preventDefault()
              void save()
            }
          }}
        />
        <div className="notes-meta">
          <span>{MOD_ENTER_LABEL} to save</span>
          <span id={counterId}>{`${notes.length} / ${MAX_TASK_NOTES}`}</span>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || unchanged}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
