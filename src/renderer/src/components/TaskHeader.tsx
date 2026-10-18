import { useState } from 'react'
import type { TaskGitStatus, UsageSummary } from '../../../shared/types'
import type { CopyEntry } from '../lib/copy'
import { baseSummary, plural } from '../lib/gitStatus'
import { shortcutLabel } from '../lib/shortcuts'
import { UsageBadge } from './UsageBadge'

/** The header's git line: checked-out branch, standing against the base, uncommitted files and the last commit. */
function GitLine({ git, baseRef }: { git: TaskGitStatus; baseRef: string }): React.JSX.Element {
  const standing = baseSummary(git, baseRef)
  return (
    <div className="task-git" aria-label="Git status">
      <span className="task-git-branch" title={`Checked-out branch: ${git.branch}`}>
        <span aria-hidden="true">⎇</span> {git.branch}
      </span>
      <span
        className={`task-git-base${git.baseMissing ? ' warn' : ''}`}
        title={
          git.baseMissing
            ? `${baseRef} could not be found (deleted or not fetched), so commits ahead/behind are unknown`
            : standing
        }
      >
        {git.baseMissing ? (
          <>⚠ {standing}</>
        ) : (
          <>
            <span className={git.ahead > 0 ? 'git-ahead' : undefined}>↑{git.ahead}</span>{' '}
            <span className={git.behind > 0 ? 'git-behind' : undefined}>↓{git.behind}</span>
            <span className="task-git-vs"> vs {baseRef}</span>
          </>
        )}
      </span>
      {git.uncommitted > 0 && (
        <span className="git-dirty" title={plural(git.uncommitted, 'uncommitted file')}>
          ●{git.uncommitted} uncommitted
        </span>
      )}
      {git.lastCommit && (
        <span
          className="task-git-commit"
          title={`Last commit ${git.lastCommit.sha}, ${git.lastCommit.relativeDate}: ${git.lastCommit.subject}`}
        >
          <code>{git.lastCommit.sha}</code> {git.lastCommit.subject}
          <span className="task-git-when"> · {git.lastCommit.relativeDate}</span>
        </span>
      )}
    </div>
  )
}

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
  /** A task's git status, once loaded, and the base ref it is compared with. */
  git?: TaskGitStatus
  baseRef?: string
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
          {props.git && props.baseRef !== undefined && <GitLine git={props.git} baseRef={props.baseRef} />}
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
