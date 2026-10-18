import { useEffect, useId, useRef, useState } from 'react'
import {
  MAX_COMMIT_MESSAGE,
  MAX_TASK_NOTES,
  MAX_TASK_PROMPT,
  type BranchList,
  type ChangeList,
  type NewTaskOptions,
  type UnsavedWork,
  type UpdateStrategy,
} from '../../../shared/types'
import { STATUS_NAMES } from '../lib/files'
import { plural } from '../lib/gitStatus'
import { cleanError } from '../lib/toasts'
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

type BranchLoad = { kind: 'loading' } | { kind: 'ready'; list: BranchList } | { kind: 'failed'; error: string }

/**
 * Asks for a new task's name, the branch it starts from and an optional first message for Claude. The branches
 * are fetched once, when the dialog opens; until they arrive (or if they can't be listed) the task starts from the repo's
 * default base. Mod+Enter creates from anywhere in the form, Esc cancels.
 */
export function NewTaskDialog(props: {
  repoName: string
  loadBranches: () => Promise<BranchList>
  onSubmit: (name: string, options: NewTaskOptions) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  // The loader the dialog opened with: App re-renders (and passes a new function) on every status poll.
  const [loadBranches] = useState(() => props.loadBranches)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [branches, setBranches] = useState<BranchLoad>({ kind: 'loading' })
  const [baseRef, setBaseRef] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const baseId = useId()
  const baseHintId = useId()
  const promptId = useId()
  const promptHintId = useId()

  useEffect(() => {
    let alive = true
    loadBranches().then(
      (list) => {
        if (!alive) return
        setBranches({ kind: 'ready', list })
        setBaseRef(list.default)
      },
      (err: unknown) => alive && setBranches({ kind: 'failed', error: cleanError(err) }),
    )
    return () => {
      alive = false
    }
  }, [loadBranches])

  const submit = async (): Promise<void> => {
    if (busyRef.current || !name.trim()) return
    busyRef.current = true
    setBusy(true)
    const options: NewTaskOptions = {}
    if (branches.kind === 'ready' && baseRef) options.baseRef = baseRef
    if (prompt.trim()) options.prompt = prompt.trim()
    try {
      await props.onSubmit(name.trim(), options)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <form
        className="dialog new-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`New task in ${props.repoName}`}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          } else if (isModEnter(e.nativeEvent)) {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <h2>
          New task <span className="dialog-title-context">in {props.repoName}</span>
        </h2>
        <input
          autoFocus
          aria-label="Name"
          placeholder="e.g. fix login bug"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="dialog-field">
          <label htmlFor={baseId}>Base branch</label>
          <select
            id={baseId}
            aria-describedby={baseHintId}
            disabled={branches.kind !== 'ready'}
            value={branches.kind === 'ready' ? baseRef : ''}
            onChange={(e) => setBaseRef(e.target.value)}
          >
            {branches.kind === 'ready' ? (
              branches.list.branches.map((b) => (
                <option key={b} value={b}>
                  {b === branches.list.default ? `${b} (default)` : b}
                </option>
              ))
            ) : (
              <option value="">{branches.kind === 'loading' ? 'Fetching branches…' : 'Default branch'}</option>
            )}
          </select>
          {branches.kind === 'failed' ? (
            <p id={baseHintId} className="dialog-field-hint dialog-field-error" role="alert">
              Could not list the branches: {branches.error}. The task will start from the default branch.
            </p>
          ) : (
            <p id={baseHintId} className="dialog-field-hint">
              The task&apos;s branch starts here; ahead/behind and changes are counted against it.
            </p>
          )}
        </div>
        <div className="dialog-field">
          <label htmlFor={promptId}>
            Initial prompt <span className="dialog-field-optional">(optional)</span>
          </label>
          <textarea
            id={promptId}
            aria-describedby={promptHintId}
            rows={5}
            maxLength={MAX_TASK_PROMPT}
            placeholder="What should Claude start with?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div id={promptHintId} className="notes-meta">
            <span>Sent to Claude when the task starts, not on restarts.</span>
            <span>{`${prompt.length} / ${MAX_TASK_PROMPT}`}</span>
          </div>
        </div>
        <div className="dialog-actions">
          <span className="dialog-actions-hint">{MOD_ENTER_LABEL} to create</span>
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

type ChangesLoad = { kind: 'loading' } | { kind: 'ready'; list: ChangeList } | { kind: 'failed'; error: string }

/**
 * "Commit all": the files `git add -A` will stage (the task's uncommitted changes, loaded when the dialog opens)
 * and a required message. Mod+Enter commits, Esc cancels. Stays open with the message when committing fails.
 */
export function CommitDialog(props: {
  taskName: string
  branch: string
  loadChanges: () => Promise<ChangeList>
  onCommit: (message: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  // The loader the dialog opened with: App passes a new function on every render.
  const [loadChanges] = useState(() => props.loadChanges)
  const [changes, setChanges] = useState<ChangesLoad>({ kind: 'loading' })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const messageId = useId()
  const counterId = useId()
  const filesId = useId()

  useEffect(() => {
    let alive = true
    loadChanges().then(
      (list) => alive && setChanges({ kind: 'ready', list }),
      (err: unknown) => alive && setChanges({ kind: 'failed', error: cleanError(err) }),
    )
    return () => {
      alive = false
    }
  }, [loadChanges])

  const files = changes.kind === 'ready' ? changes.list.files : []
  const nothing = changes.kind === 'ready' && files.length === 0
  const canCommit = !busy && message.trim() !== '' && !nothing && changes.kind !== 'loading'
  const commit = async (): Promise<void> => {
    if (busyRef.current || !canCommit) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onCommit(message.trim())
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <form
        className="dialog commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Commit all in ${props.taskName}`}
        onSubmit={(e) => {
          e.preventDefault()
          void commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          } else if (isModEnter(e.nativeEvent)) {
            e.preventDefault()
            void commit()
          }
        }}
      >
        <h2>
          Commit all <span className="dialog-title-context">on {props.branch}</span>
        </h2>
        <section className="dialog-field" aria-labelledby={filesId}>
          <h3 id={filesId} className="dialog-field-heading">
            {changes.kind === 'ready'
              ? nothing
                ? 'Nothing to commit'
                : `${plural(files.length, 'file')} will be committed`
              : 'Files'}
          </h3>
          {changes.kind === 'loading' && <p className="dialog-field-hint">Loading changes…</p>}
          {changes.kind === 'failed' && (
            <p className="dialog-field-hint dialog-field-error" role="alert">
              Could not list the changes: {changes.error}. Everything in the worktree will still be committed.
            </p>
          )}
          {nothing && <p className="dialog-field-hint">The worktree has no uncommitted changes.</p>}
          {files.length > 0 && (
            <ul className="commit-files" aria-label="Files to commit">
              {files.map((f) => (
                <li
                  key={f.path}
                  title={`${STATUS_NAMES[f.status]}: ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`}
                >
                  <span className={`badge badge-${f.status}`} aria-label={STATUS_NAMES[f.status]}>
                    {f.status}
                  </span>
                  <span className="commit-file-path">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="dialog-field">
          <label htmlFor={messageId}>Commit message</label>
          <textarea
            id={messageId}
            autoFocus
            required
            aria-describedby={counterId}
            rows={5}
            maxLength={MAX_COMMIT_MESSAGE}
            spellCheck
            placeholder={'Summary on the first line\n\nDetails after a blank line'}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="notes-meta">
            <span>git add -A, then git commit</span>
            <span id={counterId}>{`${message.length} / ${MAX_COMMIT_MESSAGE}`}</span>
          </div>
        </div>
        <div className="dialog-actions">
          <span className="dialog-actions-hint">{MOD_ENTER_LABEL} to commit</span>
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={!canCommit}>
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * An update from the base stopped on conflicts and was undone. Lists the files and offers to have the task's
 * Claude do the rebase (or merge) and resolve them.
 */
export function ConflictDialog(props: {
  branch: string
  baseRef: string
  strategy: UpdateStrategy
  files: string[]
  onAskClaude: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const ask = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onAskClaude()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const rebase = props.strategy === 'rebase'
  return (
    <div className="overlay">
      <div
        className="dialog conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Update stopped on conflicts"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          props.onClose()
        }}
      >
        <h2>Update stopped on conflicts</h2>
        <p className="conflict-summary">
          {rebase ? (
            <>
              Rebasing <code>{props.branch}</code> onto <code>{props.baseRef}</code>
            </>
          ) : (
            <>
              Merging <code>{props.baseRef}</code> into <code>{props.branch}</code>
            </>
          )}{' '}
          conflicts in {plural(props.files.length, 'file')}. It was undone (<code>git {props.strategy} --abort</code>
          ), so the branch and its files are as they were.
        </p>
        <ul className="commit-files" aria-label="Conflicting files">
          {props.files.map((f) => (
            <li key={f}>
              <span className="badge badge-D" aria-hidden="true">
                !
              </span>
              <span className="commit-file-path">{f}</span>
            </li>
          ))}
        </ul>
        <p className="dialog-field-hint">
          Claude can redo the {props.strategy} in its window and resolve the conflicts; you can follow along there.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose} disabled={busy}>
            Close
          </button>
          <button type="button" className="primary" autoFocus onClick={() => void ask()} disabled={busy}>
            {busy ? 'Asking…' : 'Ask Claude to resolve'}
          </button>
        </div>
      </div>
    </div>
  )
}
