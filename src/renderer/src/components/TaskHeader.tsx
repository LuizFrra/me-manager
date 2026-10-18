import { useState } from 'react'
import type { UsageSummary } from '../../../shared/types'
import type { CopyEntry } from '../lib/copy'
import { shortcutLabel } from '../lib/shortcuts'
import { UsageBadge } from './UsageBadge'

/**
 * The selected task's or folder's header: title, path line, and the task's notes, collapsed to one line until
 * clicked. Notes are plain text (a React text node), never HTML.
 */
export function TaskHeader(props: {
  title: string
  subtitle: string
  notes?: string
  /** Set for tasks: shows the "Edit notes" button. */
  onEditNotes?: () => void
  /** Copy buttons (branch, path, attach command). */
  copies: CopyEntry[]
  onCopy: (entry: CopyEntry) => void
  /** Opens the task's worktree or the folder in an editor / the file manager. */
  onOpenInEditor: () => void
  onRevealInFileManager: () => void
  /** Settings flags that new Claude sessions start with; shown as badges so they're never forgotten. */
  sessionFlags?: { remoteControl: boolean; skipPermissions: boolean }
  /** The target's Claude usage, once loaded: shown as a badge that opens the usage view. */
  usage?: UsageSummary
  onOpenUsage?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <header className="task-header">
      <div className="task-header-top">
        <div className="task-header-text">
          <div className="task-title">
            {props.title}
            {props.sessionFlags?.remoteControl && (
              <span className="session-badge" title="New Claude sessions start with --remote-control">
                Remote
              </span>
            )}
            {props.sessionFlags?.skipPermissions && (
              <span
                className="session-badge session-badge-warn"
                title="New Claude sessions start with --dangerously-skip-permissions: Claude runs commands without asking"
              >
                ⚠ permissions skipped
              </span>
            )}
          </div>
          <div className="task-subtitle">{props.subtitle}</div>
        </div>
        <div className="task-header-actions">
          {props.usage && props.onOpenUsage && <UsageBadge usage={props.usage} onOpen={props.onOpenUsage} />}
          <div className="copy-group" role="group" aria-label="Open">
            <span className="copy-group-label" aria-hidden="true">
              Open
            </span>
            <button
              aria-label="Open in editor"
              title={`Open in editor (${shortcutLabel('openEditor')})`}
              onClick={props.onOpenInEditor}
            >
              Editor
            </button>
            <button
              aria-label="Reveal in file manager"
              title="Reveal in file manager"
              onClick={props.onRevealInFileManager}
            >
              File manager
            </button>
          </div>
          {props.copies.length > 0 && (
            <div className="copy-group" role="group" aria-label="Copy">
              <span className="copy-group-label" aria-hidden="true">
                Copy
              </span>
              {props.copies.map((entry) => (
                <button
                  key={entry.kind}
                  aria-label={entry.label}
                  title={`${entry.label}: ${entry.text}`}
                  onClick={() => props.onCopy(entry)}
                >
                  {entry.short}
                </button>
              ))}
            </div>
          )}
          {props.onEditNotes && (
            <button className="header-btn" title="Edit the task's notes" onClick={props.onEditNotes}>
              <span aria-hidden="true">✎</span> Edit notes
            </button>
          )}
        </div>
      </div>
      {props.notes && (
        <button
          className="task-notes"
          aria-expanded={expanded}
          title={expanded ? 'Collapse notes' : 'Show all notes'}
          onClick={() => setExpanded((e) => !e)}
        >
          {props.notes}
        </button>
      )}
    </header>
  )
}
