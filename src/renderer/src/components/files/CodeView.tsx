import { useEffect, useId, useMemo, useRef } from 'react'
import { highlight, lineCount } from '../../lib/highlight'
import {
  LINE_SELECT_HINT,
  selectionBounds,
  useLineSelect,
  type LineSelection,
  type LineSelectProps,
} from '../../lib/lineSelection'

export interface CodeViewProps {
  /** Root-relative path, used to pick the language. */
  path: string
  content: string
  /** A 1-based line to mark and scroll into view (a search result). Scrolls when it or the path changes. */
  highlightLine?: number
  /** Lines can be selected by their numbers, for a review comment; row `i` is line `i + 1`. */
  select?: LineSelectProps
}

/** The gutter row a click landed on: the gutter is one <pre>, so from the click's height in it. */
function rowAt(e: React.MouseEvent<HTMLElement>, lines: number): number {
  const el = e.currentTarget
  const style = getComputedStyle(el)
  // The stylesheet's 8px padding and 18px lines (see .code-gutter) when they can't be read (tests).
  const top = parseFloat(style.paddingTop) || 8
  const height = parseFloat(style.lineHeight) || 18
  const row = Math.floor((e.clientY - el.getBoundingClientRect().top - top) / height)
  return Math.min(Math.max(row, 0), lines - 1)
}

export function CodeView({ path, content, highlightLine, select }: CodeViewProps): React.JSX.Element {
  const html = useMemo(() => highlight(path, content), [path, content])
  const lines = lineCount(content)
  const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n'), [lines])
  const mark = highlightLine !== undefined && highlightLine >= 1 && highlightLine <= lines ? highlightLine : undefined
  const markRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const hintId = useId()
  const linesFor = (sel: LineSelection): { lines: { start: number; end: number } } => {
    const [first, last] = selectionBounds(sel)
    return { lines: { start: first + 1, end: Math.min(last, lines - 1) + 1 } }
  }
  const { onKeyDown, pick } = useLineSelect(select, lines, linesFor, () => {
    const el = cursorRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  const bounds = select?.selection ? selectionBounds(select.selection).map((i) => Math.min(i, lines - 1)) : null

  // Not on content changes: a poll that brings new content must not pull the view back to the line.
  useEffect(() => {
    const el = markRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [path, mark])

  return (
    <div className="code-view">
      {select ? (
        // Focusable for the selection keys; a Shift-click would select text.
        <pre
          className="code-gutter code-gutter-select"
          data-line-select
          role="group"
          aria-label="Line numbers"
          aria-describedby={hintId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => e.shiftKey && e.preventDefault()}
          onClick={(e) => {
            e.currentTarget.focus({ preventScroll: true })
            pick(rowAt(e, lines), e.shiftKey)
          }}
        >
          {gutter}
        </pre>
      ) : (
        <pre className="code-gutter" aria-hidden="true">
          {gutter}
        </pre>
      )}
      {select && (
        <span id={hintId} hidden>
          {LINE_SELECT_HINT}
        </span>
      )}
      <pre className="code-body">
        {html === null ? (
          <code className="hljs">{content}</code>
        ) : (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
      {bounds && select?.selection && (
        <>
          <div
            className="code-line-sel"
            aria-hidden="true"
            style={{ '--sel-line': bounds[0], '--sel-lines': bounds[1] - bounds[0] + 1 } as React.CSSProperties}
          />
          <div
            ref={cursorRef}
            className="code-line-cursor"
            aria-hidden="true"
            style={{ '--sel-line': Math.min(select.selection.focus, lines - 1) } as React.CSSProperties}
          />
        </>
      )}
      {mark !== undefined && (
        <div
          ref={markRef}
          className="code-line-mark"
          data-line={mark}
          aria-hidden="true"
          style={{ '--mark-line': mark - 1 } as React.CSSProperties}
        />
      )}
    </div>
  )
}
