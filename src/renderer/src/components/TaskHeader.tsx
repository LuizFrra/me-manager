import { useState } from 'react'
import type { CopyEntry } from '../lib/copy'

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
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <header className="task-header">
      <div className="task-header-top">
        <div className="task-header-text">
          <div className="task-title">{props.title}</div>
          <div className="task-subtitle">{props.subtitle}</div>
        </div>
        <div className="task-header-actions">
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
