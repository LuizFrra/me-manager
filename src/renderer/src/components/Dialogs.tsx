import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  hasUnsavedWork,
  MAX_COMMIT_MESSAGE,
  MAX_TASK_NOTES,
  MAX_TASK_PROMPT,
  type BranchList,
  type ChangeList,
  type NewTaskOptions,
  type TaskTemplate,
  type UnsavedWork,
  type UpdateStrategy,
} from '../../../shared/types'
import { budgetFromText, budgetText } from '../../../shared/budget'
import { cloneNameError, cloneNameFromUrl, cloneUrlError } from '../../../shared/clone'
import { branchName, slugify } from '../../../shared/naming'
import { MAX_RUN_COMMAND, runCommandError } from '../../../shared/runCommand'
import { expandTaskName, templateBase } from '../../../shared/templates'
import { archiveSkipReason, type BulkAction } from '../lib/bulk'
import { STATUS_NAMES } from '../lib/files'
import { plural } from '../lib/gitStatus'
import { cleanError, errorSummary } from '../lib/toasts'
import { formatCost } from '../lib/usageFormat'
import { isModEnter, MOD_ENTER_LABEL } from '../lib/shortcuts'
import { useRestoreFocus } from '../lib/useRestoreFocus'
import { MAX_REVIEW_NOTE } from '../lib/review'
import { newTaskNameError, type ExistingTask } from '../lib/names'

/** A dialog's keydown handler: Esc cancels from any of its controls, not only from the field being typed in. */
const cancelOnEscape =
  (cancel: () => void) =>
  (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    cancel()
  }

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
  /** Why main would refuse the name (see lib/names), shown as it is typed with the button off; null when fine. */
  validate?: (name: string) => string | null
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus() // closing gives focus back, usually to the terminal
  const [name, setName] = useState(props.initial ?? '')
  const [busy, setBusy] = useState(false)
  const unchanged = props.initial !== undefined && name.trim() === props.initial
  const error = props.validate?.(name) ?? null
  const noteId = useId()
  const errorId = useId()
  const describedBy = [error && errorId, props.note && noteId].filter(Boolean).join(' ') || undefined
  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={cancelOnEscape(props.onCancel)}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim() || unchanged || error) return
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
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          placeholder={props.placeholder}
          value={name}
          onFocus={(e) => props.initial !== undefined && e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
        {error && (
          <p id={errorId} className="dialog-field-hint dialog-field-error" role="alert">
            {error}
          </p>
        )}
        {props.note && (
          <p id={noteId} className="dialog-note">
            {props.note}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || unchanged || error !== null}>
            {busy ? 'Working…' : (props.submitLabel ?? 'Create')}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Sets, changes or (emptied) removes a repo's or folder's run command: one line of shell, checked as main checks it.
 * Enter saves, Esc cancels.
 */
export function RunCommandDialog(props: {
  itemName: string
  kind: 'repo' | 'folder'
  /** The current command; '' when there is none. */
  initial: string
  onSave: (command: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const [command, setCommand] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const noteId = useId()
  const errorId = useId()
  const error = runCommandError(command)
  const trimmed = command.trim()
  const unchanged = trimmed === props.initial.trim()
  const removing = trimmed === '' && !unchanged
  const save = async (): Promise<void> => {
    if (busyRef.current || unchanged || error) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onSave(trimmed)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const where =
    props.kind === 'repo'
      ? `It runs in a “run” tab of the selected task, in its worktree, for every task of ${props.itemName}.`
      : 'It runs in a “run” tab of the folder’s session, in the folder.'
  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Run command for ${props.itemName}`}
        onKeyDown={cancelOnEscape(props.onCancel)}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>Run command for “{props.itemName}”</h2>
        <input
          autoFocus
          className="run-command-input"
          aria-label="Command"
          aria-describedby={`${noteId}${error ? ` ${errorId}` : ''}`}
          aria-invalid={error ? true : undefined}
          placeholder="e.g. npm run dev"
          spellCheck={false}
          maxLength={MAX_RUN_COMMAND + 100}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        {error && (
          <p id={errorId} className="dialog-field-hint dialog-field-error" role="alert">
            {error}
          </p>
        )}
        <p id={noteId} className="dialog-note">
          {where} Your shell runs it, so pipes, <code>&amp;&amp;</code> and variables work; the tab stays open with its
          output when it exits. Leave it empty to remove it.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || unchanged || error !== null}>
            {busy ? 'Saving…' : removing ? 'Remove' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Asked before removing a task with unsaved work (or that could not be checked), listing it. Cancel is focused, so
 * Enter loses nothing; Esc cancels.
 */
export function RemoveTaskDialog(props: {
  taskName: string
  work: UnsavedWork
  onConfirm: (deleteBranch: boolean) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const [deleteBranch, setDeleteBranch] = useState(false)
  const { busy, run } = useSingleRun(() => props.onConfirm(deleteBranch))
  const { uncommittedFiles, unpushedCommits, warning } = props.work
  const hasChanges = uncommittedFiles.length > 0 || unpushedCommits.length > 0
  return (
    <div className="overlay">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Remove ${props.taskName}`}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || busy) return
          e.preventDefault()
          props.onCancel()
        }}
      >
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
            <h3>{plural(uncommittedFiles.length, 'uncommitted file')}</h3>
            <ul>
              {uncommittedFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        )}
        {unpushedCommits.length > 0 && (
          <>
            <h3>{plural(unpushedCommits.length, 'unpushed commit')}</h3>
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
          <button type="button" autoFocus onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void run()} disabled={busy}>
            {busy ? 'Removing…' : 'Remove anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Runs `action` at most once at a time: `busy` is set meanwhile, and the ref also blocks a second click that lands
 * before React re-renders with the buttons disabled.
 */
function useSingleRun(action: () => Promise<void>): { busy: boolean; run: () => Promise<void> } {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const run = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await action()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return { busy, run }
}

/**
 * Asked before archiving a task whose worktree has uncommitted or untracked files (or could not be checked):
 * archiving removes the worktree, so they would be lost. Its commits are not listed: the kept branch has them.
 * Cancel is focused, so Enter doesn't discard anything; Esc cancels.
 */
export function ArchiveTaskDialog(props: {
  taskName: string
  work: UnsavedWork
  onConfirm: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const { busy, run } = useSingleRun(props.onConfirm)
  const { uncommittedFiles, warning } = props.work
  const n = uncommittedFiles.length
  return (
    <div className="overlay">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Archive ${props.taskName}`}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || busy) return
          e.preventDefault()
          props.onCancel()
        }}
      >
        <h2>Archive “{props.taskName}”?</h2>
        <p>
          Archiving removes the task’s worktree and closes its session; its branch and commits are kept, and it can be
          restored later. Commit or discard the changes first, or archive anyway and lose them.
        </p>
        {warning && (
          <div className="dialog-warning" role="alert">
            <strong>Could not check the worktree for changes.</strong>
            <p>{warning}</p>
          </div>
        )}
        {n > 0 && (
          <>
            <h3>{plural(n, 'uncommitted or untracked file', 'uncommitted or untracked files')}</h3>
            <ul>
              {uncommittedFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void run()} disabled={busy}>
            {busy ? 'Archiving…' : 'Archive anyway (discards changes)'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Confirms deleting an archived task: the task goes and its branch is deleted (`git branch -D`). Warns when the
 * branch has commits that are neither on the task's base nor pushed, as they would be lost (they are listed).
 * Cancel is focused; Esc cancels.
 */
export function DeleteArchivedTaskDialog(props: {
  taskName: string
  branch: string
  baseRef: string
  /** From checkTaskRemoval: `unpushedCommits` are the branch's commits that only it has. */
  work: UnsavedWork
  onConfirm: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const { busy, run } = useSingleRun(props.onConfirm)
  const { unpushedCommits, warning } = props.work
  const n = unpushedCommits.length
  return (
    <div className="overlay">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Delete archived task ${props.taskName}`}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || busy) return
          e.preventDefault()
          props.onCancel()
        }}
      >
        <h2>Delete “{props.taskName}”?</h2>
        <p>The archived task is removed from me-manager and its branch is deleted:</p>
        <code className="confirm-remove-path">{props.branch}</code>
        {warning && (
          <div className="dialog-warning" role="alert">
            <strong>Could not fully check the branch.</strong>
            <p>{warning}</p>
          </div>
        )}
        {n > 0 ? (
          <>
            <div className="dialog-warning" role="alert">
              <strong>
                The branch has {plural(n, 'commit')} that {n === 1 ? 'is' : 'are'} not on {props.baseRef} or pushed.
              </strong>
              <p>{n === 1 ? 'It is' : 'They are'} lost when the branch is deleted.</p>
            </div>
            <ul>
              {unpushedCommits.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        ) : (
          !warning && (
            <p className="dialog-safe">
              <span aria-hidden="true">✓</span> Every commit on it is on {props.baseRef} or pushed.
            </p>
          )
        )}
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void run()} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete task and branch'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** What ConfirmRemoveDialog removes: a theme, or a repository or folder of a theme. */
export type RemovalKind = 'theme' | 'repo' | 'folder'

const REMOVAL_NOUN: Record<RemovalKind, string> = { theme: 'theme', repo: 'repository', folder: 'folder' }

/**
 * Confirms removing a theme, repository or folder from the app. Nothing on disk is touched, which the dialog says
 * plainly, and the removal can be undone from the toast that follows. Enter removes, Esc cancels.
 */
export function ConfirmRemoveDialog(props: {
  kind: RemovalKind
  name: string
  /** The theme a repository or folder is removed from. */
  themeName?: string
  /** The folder on disk (repositories and folders). */
  path?: string
  /** For a theme: what goes with it, e.g. "2 repositories and 1 folder". */
  contents?: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const noun = REMOVAL_NOUN[props.kind]
  const descId = useId()
  const confirm = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onConfirm()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const from = props.themeName ? (
    <>
      {' '}
      from <strong>{props.themeName}</strong>
    </>
  ) : null
  return (
    <div className="overlay">
      <div
        className="dialog confirm-remove-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Remove ${noun} ${props.name}`}
        aria-describedby={descId}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || busy) return
          e.preventDefault()
          props.onCancel()
        }}
      >
        <h2>
          Remove {noun} “{props.name}”?
        </h2>
        <div id={descId} className="confirm-remove-body">
          {props.kind === 'theme' ? (
            <p>
              The theme is removed from me-manager
              {props.contents ? <>, with its {props.contents}</> : null}.
            </p>
          ) : (
            <p>
              The {noun} is removed{from}
              {props.kind === 'folder' ? ', and its terminal session is closed' : ''}.
            </p>
          )}
          {props.path && <code className="confirm-remove-path">{props.path}</code>}
          <p className="dialog-safe">
            <span aria-hidden="true">✓</span> Your files on disk are not touched.
          </p>
        </div>
        <div className="dialog-actions">
          <span className="dialog-actions-hint">You can undo this right after.</span>
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" autoFocus onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * "Clone repository…": a URL, the folder to clone into (the last one used, or picked) and the new folder's name,
 * taken from the URL until it is edited. Shows a spinner while main clones (there is no progress report), and
 * stays open with git's error when cloning fails. Can't be closed meanwhile: the clone can't be stopped.
 */
export function CloneRepoDialog(props: {
  themeName: string
  /** The folder to clone into at first (Settings.cloneDirectory); '' when none was used yet. */
  initialParent: string
  pickDirectory: () => Promise<string | null>
  /** Rejects with the reason when cloning fails. */
  onClone: (url: string, parentDir: string, name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(props.initialParent)
  // null: follow the URL; a string once the user edits the name.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [urlTouched, setUrlTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const urlId = useId()
  const urlHintId = useId()
  const nameId = useId()
  const nameHintId = useId()
  const parentId = useId()

  const name = typedName ?? cloneNameFromUrl(url)
  const urlError = cloneUrlError(url)
  const nameError = cloneNameError(name)
  const showUrlError = urlError !== null && urlTouched && url.trim() !== ''
  const showNameError = nameError !== null && (typedName !== null || (urlError === null && url.trim() !== ''))
  const canClone = !busy && urlError === null && nameError === null && parent !== ''
  const dest = parent && !nameError ? `${parent.replace(/\/+$/, '')}/${name.trim()}` : null

  const pick = async (): Promise<void> => {
    try {
      const picked = await props.pickDirectory()
      if (picked) setParent(picked)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const clone = async (): Promise<void> => {
    setUrlTouched(true)
    if (busyRef.current || !canClone) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await props.onClone(url.trim(), parent, name.trim())
    } catch (err) {
      setError(cleanError(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <form
        className="dialog clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Clone repository into ${props.themeName}`}
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault()
          void clone()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          if (!busyRef.current) props.onCancel()
        }}
      >
        <h2>
          Clone repository <span className="dialog-title-context">into {props.themeName}</span>
        </h2>
        <div className="dialog-field">
          <label htmlFor={urlId}>Repository URL</label>
          <input
            id={urlId}
            type="text"
            className="mono"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            aria-describedby={urlHintId}
            aria-invalid={showUrlError}
            placeholder="https://github.com/owner/repo.git"
            disabled={busy}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            onBlur={() => setUrlTouched(true)}
          />
          {showUrlError ? (
            <p id={urlHintId} className="dialog-field-hint dialog-field-error" role="alert">
              {urlError}
            </p>
          ) : (
            <p id={urlHintId} className="dialog-field-hint">
              https://, ssh://, git@host:path or file://
            </p>
          )}
        </div>
        <div className="dialog-field">
          <label htmlFor={parentId}>Clone into</label>
          <div className="clone-parent">
            <input
              id={parentId}
              type="text"
              className="mono"
              readOnly
              placeholder="No folder chosen"
              title={parent || undefined}
              value={parent}
            />
            <button type="button" onClick={() => void pick()} disabled={busy}>
              Choose…
            </button>
          </div>
        </div>
        <div className="dialog-field">
          <label htmlFor={nameId}>Folder name</label>
          <input
            id={nameId}
            type="text"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            aria-describedby={nameHintId}
            aria-invalid={showNameError}
            placeholder="from the URL"
            disabled={busy}
            value={name}
            onChange={(e) => {
              setTypedName(e.target.value)
              setError(null)
            }}
          />
          {showNameError ? (
            <p id={nameHintId} className="dialog-field-hint dialog-field-error" role="alert">
              {nameError}
            </p>
          ) : (
            <p id={nameHintId} className="dialog-field-hint">
              {dest ? (
                <>
                  Clones to <code>{dest}</code>, which must not exist yet.
                </>
              ) : (
                'A new folder, named after the repository unless you change it.'
              )}
            </p>
          )}
        </div>
        {busy && (
          <p className="clone-busy" role="status">
            Cloning… Large repositories can take a few minutes.
          </p>
        )}
        {error && (
          <div className="dialog-warning clone-error" role="alert">
            <strong>Could not clone</strong>
            <p>{error}</p>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canClone}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Writes or edits a review comment's note on `location` (see reviewLocation). With `initial`, saving it unchanged is
 * disabled.
 */
export function ReviewCommentDialog(props: {
  location: string
  initial?: string
  onSave: (note: string) => void
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus() // back to the line numbers, or the tray's Edit button
  const [note, setNote] = useState(props.initial ?? '')
  const counterId = useId()
  const editing = props.initial !== undefined
  const title = editing ? `Edit the comment on ${props.location}` : `Comment on ${props.location}`
  const blocked = !note.trim() || (editing && note.trim() === props.initial?.trim())
  const save = (): void => {
    if (!blocked) props.onSave(note.trim())
  }
  return (
    <div className="overlay">
      <form
        className="dialog notes-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={cancelOnEscape(props.onCancel)}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h2 className="review-dialog-title">{title}</h2>
        <textarea
          autoFocus
          aria-label="Comment"
          aria-describedby={counterId}
          rows={6}
          maxLength={MAX_REVIEW_NOTE}
          placeholder="What should Claude change here?"
          value={note}
          onFocus={(e) => editing && e.currentTarget.select()}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (!isModEnter(e.nativeEvent)) return
            e.preventDefault()
            save()
          }}
        />
        <div className="notes-meta">
          <span>{MOD_ENTER_LABEL} to save</span>
          <span id={counterId}>{`${note.length} / ${MAX_REVIEW_NOTE}`}</span>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={blocked}>
            {editing ? 'Save' : 'Add comment'}
          </button>
        </div>
      </form>
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
  useRestoreFocus()
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
        aria-modal="true"
        aria-label={`Notes for ${props.taskName}`}
        onKeyDown={cancelOnEscape(props.onCancel)}
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
            if (!isModEnter(e.nativeEvent)) return
            e.preventDefault()
            void save()
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

/**
 * Sets, changes or (emptied) removes a task's own budget, in dollars; without one the default task budget from
 * Settings applies. Enter saves, Esc cancels.
 */
export function BudgetDialog(props: {
  taskName: string
  /** The task's own budget; null when it has none. */
  initial: number | null
  /** Settings.taskBudgetUsd, what applies without one. */
  defaultBudget: number | null
  onSave: (budgetUsd: number | null) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const [text, setText] = useState(budgetText(props.initial))
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const noteId = useId()
  const errorId = useId()
  const parsed = budgetFromText(text)
  const error = 'error' in parsed ? parsed.error : null
  const value = 'value' in parsed ? parsed.value : null
  const unchanged = error === null && value === props.initial
  const removing = error === null && value === null && !unchanged
  const save = async (): Promise<void> => {
    if (busyRef.current || unchanged || error) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onSave(value)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const fallback =
    props.defaultBudget === null
      ? 'Leave it empty for no budget.'
      : `Leave it empty for the default task budget (${formatCost(props.defaultBudget)}).`
  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Budget for ${props.taskName}`}
        onKeyDown={cancelOnEscape(props.onCancel)}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>Budget for “{props.taskName}”</h2>
        <div className="budget-input">
          <span aria-hidden="true">$</span>
          <input
            autoFocus
            aria-label="Budget"
            aria-describedby={`${noteId}${error ? ` ${errorId}` : ''}`}
            aria-invalid={error ? true : undefined}
            inputMode="decimal"
            placeholder={props.defaultBudget === null ? 'None' : budgetText(props.defaultBudget)}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {error && (
          <p id={errorId} className="dialog-field-hint dialog-field-error" role="alert">
            {error}
          </p>
        )}
        <p id={noteId} className="dialog-note">
          A limit on the task&apos;s estimated cost, all time. Its usage badge turns amber at 80% and red at 100%, with
          a notification at each. {fallback}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || unchanged || error !== null}>
            {busy ? 'Saving…' : removing ? 'Remove' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

type BranchLoad = { kind: 'loading' } | { kind: 'ready'; list: BranchList } | { kind: 'failed'; error: string }

/** What the chosen template filled in, so choosing another one (or None) can tell it from what the user typed. */
interface Prefill {
  name: string
  prompt: string
  /** The base it selected; '' when it selected none. */
  baseRef: string
}

/**
 * Asks for a new task's name, the branch it starts from and an optional first message for Claude. The branches
 * are fetched once, when the dialog opens; until they arrive (or if they can't be listed) the task starts from the repo's
 * default base. Mod+Enter creates from anywhere in the form, Esc cancels. A name main would refuse (no letters or
 * numbers, or another task's name or branch) is explained under the field, with Create off; a valid one shows its
 * branch.
 *
 * With templates, a "Template" choice comes first: picking one fills in the fields it sets (all stay editable),
 * and clears what the previous template filled in unless the user has changed it since. A template's base that
 * the repo lacks gives the default branch, with a note saying so (see templateBase).
 */
export function NewTaskDialog(props: {
  repoName: string
  /** The theme's slug, for the branch the name gives (see branchName). */
  themeSlug?: string
  loadBranches: () => Promise<BranchList>
  /** The task templates to choose from (Settings.taskTemplates). */
  templates?: TaskTemplate[]
  /** The repo's tasks, archived ones included: names taken, and what a template's `{n}` counts. */
  tasks?: readonly ExistingTask[]
  /** The template chosen when the dialog opens, by name; None when no template has that name. */
  initialTemplate?: string
  /** The name and prompt it opens with (the home composer's), kept as typed when a template is chosen. */
  initialName?: string
  initialPrompt?: string
  /** `template`: the name of the template chosen when creating, if any. */
  onSubmit: (name: string, options: NewTaskOptions, template?: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const templates = props.templates ?? []
  const taskNames = (props.tasks ?? []).map((t) => t.name)
  // The loader the dialog opened with: App re-renders (and passes a new function) on every status poll.
  const [loadBranches] = useState(() => props.loadBranches)
  const [initial] = useState(() => {
    const template = templates.find((t) => t.name === props.initialTemplate)
    const name = template?.taskName ? expandTaskName(template.taskName, taskNames, new Date()) : ''
    return { template, prefill: { name, prompt: template?.prompt ?? '', baseRef: '' } }
  })
  const [templateName, setTemplateName] = useState(initial.template?.name ?? '')
  const prefill = useRef<Prefill>({ ...initial.prefill })
  // The chosen template's base, for when the branches arrive.
  const wantedBase = useRef(initial.template?.base)
  const [name, setName] = useState(props.initialName ?? initial.prefill.name)
  const [prompt, setPrompt] = useState(props.initialPrompt ?? initial.prefill.prompt)
  const [branches, setBranches] = useState<BranchLoad>({ kind: 'loading' })
  const [baseRef, setBaseRef] = useState('')
  // A template's base that the repo doesn't have (the default was selected instead).
  const [missingBase, setMissingBase] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const templateId = useId()
  const nameId = useId()
  const nameHintId = useId()
  const baseId = useId()
  const baseHintId = useId()
  const promptId = useId()
  const promptHintId = useId()

  /** Selects the base `wantedBase` asks for in `list` (the default when none), noting one the repo lacks. */
  const selectBase = useCallback((list: BranchList): void => {
    const { baseRef: ref, missing } = templateBase(wantedBase.current, list)
    setBaseRef(ref)
    setMissingBase(missing ?? null)
    prefill.current.baseRef = wantedBase.current ? ref : ''
  }, [])

  useEffect(() => {
    let alive = true
    loadBranches().then(
      (list) => {
        if (!alive) return
        setBranches({ kind: 'ready', list })
        selectBase(list)
      },
      (err: unknown) => alive && setBranches({ kind: 'failed', error: cleanError(err) }),
    )
    return () => {
      alive = false
    }
  }, [loadBranches, selectBase])

  /**
   * Fills in what `template` sets; clears what the last one set and the user left alone (None: no template). The
   * name and prompt the dialog opened with (the composer's) are the user's text: a template never replaces them.
   */
  const chooseTemplate = (template: TaskTemplate | undefined): void => {
    const last = prefill.current
    const keepName = name !== '' && name === props.initialName
    const keepPrompt = prompt !== '' && prompt === props.initialPrompt
    const nextName = keepName
      ? name
      : template?.taskName
        ? expandTaskName(template.taskName, taskNames, new Date())
        : name === last.name
          ? ''
          : name
    const nextPrompt = keepPrompt ? prompt : (template?.prompt ?? (prompt === last.prompt ? '' : prompt))
    setTemplateName(template?.name ?? '')
    setName(nextName)
    setPrompt(nextPrompt)
    prefill.current = {
      name: template?.taskName && !keepName ? nextName : '',
      prompt: keepPrompt ? '' : (template?.prompt ?? ''),
      baseRef: '',
    }
    wantedBase.current = template?.base
    if (branches.kind !== 'ready') return
    if (template?.base || baseRef === last.baseRef) selectBase(branches.list)
    else setMissingBase(null)
  }

  const nameError = newTaskNameError(name, props.tasks ?? [])
  const slug = slugify(name)

  const submit = async (): Promise<void> => {
    if (busyRef.current || !name.trim() || nameError) return
    busyRef.current = true
    setBusy(true)
    const options: NewTaskOptions = {}
    if (branches.kind === 'ready' && baseRef) options.baseRef = baseRef
    if (prompt.trim()) options.prompt = prompt.trim()
    try {
      await props.onSubmit(name.trim(), options, templateName || undefined)
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
        {templates.length > 0 && (
          <div className="dialog-field">
            <label htmlFor={templateId}>Template</label>
            <select
              id={templateId}
              className="template-select"
              value={templateName}
              onChange={(e) => chooseTemplate(templates.find((t) => t.name === e.target.value))}
            >
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="dialog-field">
          <label htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            autoFocus
            aria-describedby={nameHintId}
            aria-invalid={nameError ? true : undefined}
            placeholder="e.g. fix login bug"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError ? (
            <p id={nameHintId} className="dialog-field-hint dialog-field-error" role="alert">
              {nameError}
            </p>
          ) : (
            <p id={nameHintId} className="dialog-field-hint">
              {slug && props.themeSlug ? (
                <>
                  Branch: <code>{branchName(props.themeSlug, slug)}</code>
                </>
              ) : (
                'Also names the task’s branch and folder.'
              )}
            </p>
          )}
        </div>
        <div className="dialog-field">
          <label htmlFor={baseId}>Base branch</label>
          <select
            id={baseId}
            aria-describedby={baseHintId}
            disabled={branches.kind !== 'ready'}
            value={branches.kind === 'ready' ? baseRef : ''}
            onChange={(e) => {
              setBaseRef(e.target.value)
              setMissingBase(null)
            }}
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
          ) : branches.kind === 'ready' && missingBase !== null ? (
            <p id={baseHintId} className="dialog-field-hint dialog-field-warning" role="status">
              The template&apos;s base {missingBase} isn&apos;t in {props.repoName}: starting from{' '}
              {branches.list.default}, the default.
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
          <button type="submit" disabled={busy || !name.trim() || nameError !== null}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

type ChangesLoad = { kind: 'loading' } | { kind: 'ready'; list: ChangeList } | { kind: 'failed'; error: string }

/** Why a commit failed: its start on a line, and git's whole output (a hook's can be long) behind a disclosure. */
function CommitError({ error }: { error: string }): React.JSX.Element {
  const text = error.replace(/^git commit failed: /, '')
  const { summary, more } = errorSummary(text)
  return (
    <div className="dialog-warning commit-error" role="alert">
      <strong>Could not commit</strong> <p>{summary}</p>
      {more && (
        <details>
          <summary>Full output</summary>
          <p className="commit-error-output">{text}</p>
        </details>
      )}
    </div>
  )
}

/**
 * "Commit all": the files `git add -A` will stage (the task's uncommitted changes, loaded when the dialog opens)
 * and a required message. Mod+Enter commits, Esc cancels (not while committing). When committing fails (a
 * pre-commit hook, a missing identity) it stays open with the message and shows git's error.
 */
export function CommitDialog(props: {
  taskName: string
  branch: string
  loadChanges: () => Promise<ChangeList>
  /** Rejects with the reason when committing fails. */
  onCommit: (message: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  // The loader the dialog opened with: App passes a new function on every render.
  const [loadChanges] = useState(() => props.loadChanges)
  const [changes, setChanges] = useState<ChangesLoad>({ kind: 'loading' })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
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
    setError(null)
    try {
      await props.onCommit(message.trim())
    } catch (err) {
      setError(cleanError(err))
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
            // Like Cancel, off while committing: closing then would lose the message if the commit fails.
            if (!busyRef.current) props.onCancel()
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
        {error && <CommitError error={error} />}
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
  useRestoreFocus()
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

/** Asks which theme something goes into, when there are several. Esc or Cancel closes it. */
export function ChooseThemeDialog(props: {
  title: string
  themes: { id: string; name: string; icon?: string }[]
  onChoose: (themeId: string) => void
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  return (
    <div className="overlay">
      <div
        className="dialog choose-theme-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          props.onCancel()
        }}
      >
        <h2>{props.title}</h2>
        <p className="dialog-note">Which theme should it go into?</p>
        <ul className="choose-theme-list">
          {props.themes.map((theme, i) => (
            <li key={theme.id}>
              <button autoFocus={i === 0} onClick={() => props.onChoose(theme.id)}>
                {theme.icon && <span aria-hidden="true">{theme.icon} </span>}
                {theme.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** A task as a bulk confirmation lists it. `work`: what checkTaskRemoval found (Remove and Archive only). */
export interface BulkDialogTask {
  id: string
  name: string
  repoName: string
  branch: string
  work?: UnsavedWork
}

const BULK_VERB: Record<BulkAction, string> = { push: 'Push', update: 'Update', archive: 'Archive', remove: 'Remove' }

/** How many of a task's files or commits the Remove confirmation lists; the rest are counted. */
const BULK_LIST_MAX = 5

/** Up to BULK_LIST_MAX entries of `items`, under a heading that counts them all. */
function CappedList({ items, heading }: { items: string[]; heading: string }): React.JSX.Element | null {
  if (items.length === 0) return null
  const rest = items.length - BULK_LIST_MAX
  return (
    <>
      <h4>{heading}</h4>
      <ul>
        {items.slice(0, BULK_LIST_MAX).map((f) => (
          <li key={f}>{f}</li>
        ))}
        {rest > 0 && <li className="bulk-task-more">and {rest} more</li>}
      </ul>
    </>
  )
}

/** What a task's line in the Remove confirmation says about its unsaved work. */
function RemovalWork({ work }: { work: UnsavedWork }): React.JSX.Element {
  if (!hasUnsavedWork(work))
    return (
      <p className="dialog-safe">
        <span aria-hidden="true">✓</span> No unsaved work
      </p>
    )
  return (
    <div className="bulk-task-work">
      {work.warning && <p className="bulk-task-warning">Could not fully check: {work.warning}</p>}
      <CappedList items={work.uncommittedFiles} heading={plural(work.uncommittedFiles.length, 'uncommitted file')} />
      <CappedList items={work.unpushedCommits} heading={plural(work.unpushedCommits.length, 'unpushed commit')} />
    </div>
  )
}

/**
 * The one confirmation of a bulk action on the selected tasks, listing them. Remove shows each task's unsaved
 * work and offers to delete the branches: on at first only when none has any, as a clean task's branch goes when
 * it is removed on its own. Archive marks the tasks it leaves out (see archiveSkipReason). Confirming closes it:
 * the batch runs in the background, and ends with one summary toast. Esc cancels; Cancel is focused for Archive
 * and Remove, so Enter loses nothing.
 */
export function BulkConfirmDialog(props: {
  action: BulkAction
  tasks: BulkDialogTask[]
  /** How Update from base updates (Settings.updateStrategy). */
  strategy: UpdateStrategy
  onConfirm: (deleteBranches: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  useRestoreFocus()
  const { action, tasks } = props
  const unsaved = tasks.some((t) => t.work && hasUnsavedWork(t.work))
  const [deleteBranches, setDeleteBranches] = useState(!unsaved)
  const destructive = action === 'archive' || action === 'remove'
  const runs = action === 'archive' ? tasks.filter((t) => !archiveSkipReason(t.work)).length : tasks.length
  const verb = BULK_VERB[action]
  const title = `${verb} ${plural(tasks.length, 'task')}`
  const intro = {
    push: 'Each task’s branch is pushed to origin and set as its upstream (git push -u).',
    update:
      props.strategy === 'rebase'
        ? 'Fetches, then rebases each task’s branch onto its base (git rebase).'
        : 'Fetches, then merges each task’s base into its branch (git merge --no-edit).',
    archive:
      'Archiving removes each task’s worktree and closes its session; the branches and their commits are kept, and the tasks can be restored later.',
    remove: 'Each task’s session is closed, its worktree removed and the task dropped.',
  }[action]
  return (
    <div className="overlay">
      <div
        className="dialog bulk-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          props.onCancel()
        }}
      >
        <h2>{title}?</h2>
        <p>{intro}</p>
        {action === 'update' && (
          <p className="dialog-field-hint">
            A task whose update conflicts is put back as it was, and named in the summary, to update on its own.
          </p>
        )}
        <ul className="bulk-task-list" aria-label="Tasks">
          {tasks.map((t) => {
            const skip = action === 'archive' ? archiveSkipReason(t.work) : undefined
            return (
              <li key={t.id}>
                <div className="bulk-task-head">
                  <span className="bulk-task-name">{t.name}</span>
                  <span className="bulk-task-repo">{t.repoName}</span>
                </div>
                {(action === 'push' || action === 'update') && <code className="bulk-task-branch">{t.branch}</code>}
                {skip && (
                  <p className="bulk-task-warning">
                    Skipped: {skip}
                    {t.work?.warning ? ` (${t.work.warning})` : ''}. Archive it on its own to discard its changes.
                  </p>
                )}
                {action === 'remove' && t.work && <RemovalWork work={t.work} />}
              </li>
            )
          })}
        </ul>
        {action === 'remove' && (
          <label className="checkbox">
            <input type="checkbox" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} />
            Also delete the branches
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" autoFocus={destructive} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? 'danger' : 'primary'}
            autoFocus={!destructive}
            disabled={runs === 0}
            onClick={() => props.onConfirm(deleteBranches)}
          >
            {verb} {plural(runs, 'task')}
            {action === 'remove' && unsaved ? ' anyway' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
