import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MAX_CLAUDE_MESSAGE } from '../../../../shared/types'
import { formatReview, reviewLocation, type ReviewComment } from '../../lib/review'

export interface ReviewTrayProps {
  comments: readonly ReviewComment[]
  /** The comments are being sent to Claude. */
  sending: boolean
  /** Shows the comment's lines, in the tab it was made in. */
  onOpen: (comment: ReviewComment) => void
  onEdit: (comment: ReviewComment) => void
  onDelete: (comment: ReviewComment) => void
  onSend: () => void
  onCopy: () => void
}

/**
 * The review comments of a task or folder, at the top of the side panel: each one's location (which opens it) and
 * note, to edit or delete, and "Send to Claude" / "Copy" for all of them as one message (see formatReview).
 */
export function ReviewTray(p: ReviewTrayProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Deleting a comment takes its buttons away: focus goes to the next one's Delete (the previous one's for the last
  // comment), or to the toggle when none is left.
  const pendingFocus = useRef<number | null | undefined>(undefined)
  useLayoutEffect(() => {
    const id = pendingFocus.current
    if (id === undefined) return
    pendingFocus.current = undefined
    const next =
      id === null ? null : listRef.current?.querySelector<HTMLElement>(`[data-comment="${id}"] .review-delete`)
    ;(next ?? toggleRef.current)?.focus()
  })
  const length = useMemo(() => formatReview(p.comments).length, [p.comments])
  const tooLong = length > MAX_CLAUDE_MESSAGE

  const remove = (comment: ReviewComment, index: number): void => {
    const next = p.comments[index + 1] ?? p.comments[index - 1]
    pendingFocus.current = next ? next.id : null
    p.onDelete(comment)
  }

  return (
    <section className="review-tray" aria-label="Review comments">
      <div className="review-tray-header">
        <button
          ref={toggleRef}
          className="review-toggle"
          aria-expanded={open}
          title={open ? 'Hide the review comments' : 'Show the review comments'}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Review{' '}
          <span className="panel-count">{p.comments.length}</span>
        </button>
        <div className="review-actions">
          <button className="viewer-btn" title="Copy the comments as one message" onClick={p.onCopy}>
            Copy
          </button>
          <button
            className="viewer-btn primary"
            disabled={p.sending || tooLong || p.comments.length === 0}
            title="Paste the comments into Claude's prompt, to read and send with Enter"
            onClick={p.onSend}
          >
            {p.sending ? 'Sending…' : 'Send to Claude'}
          </button>
        </div>
      </div>
      {tooLong && (
        <div className="panel-notice">
          The review is too long to send ({length.toLocaleString('en-US')} of{' '}
          {MAX_CLAUDE_MESSAGE.toLocaleString('en-US')} characters): copy it, or delete some comments.
        </div>
      )}
      {open && (
        <ul className="review-list" ref={listRef}>
          {p.comments.map((comment, index) => {
            const location = reviewLocation(comment)
            return (
              <li key={comment.id} className="review-item" data-comment={comment.id}>
                <div className="review-item-head">
                  <button
                    className="review-location"
                    title={comment.tab === 'changes' ? 'Show the diff' : 'Show the lines'}
                    onClick={() => p.onOpen(comment)}
                  >
                    {location}
                  </button>
                  <button
                    className="panel-icon review-edit"
                    aria-label={`Edit the comment on ${location}`}
                    title="Edit"
                    onClick={() => p.onEdit(comment)}
                  >
                    ✎
                  </button>
                  <button
                    className="panel-icon review-delete"
                    aria-label={`Delete the comment on ${location}`}
                    title="Delete"
                    onClick={() => remove(comment, index)}
                  >
                    ✕
                  </button>
                </div>
                <p className="review-note">{comment.note}</p>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
