import { useRef, useState } from 'react'
import type { UnsavedWork } from '../../../shared/types'

export function NameDialog(props: {
  title: string
  placeholder: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-label={props.title}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
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
          placeholder={props.placeholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
        />
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Working…' : 'Create'}
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
  const { uncommittedFiles, unpushedCommits } = props.work
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
        <p>This task has work that will be lost:</p>
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
