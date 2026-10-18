import { useEffect, useMemo, useRef } from 'react'
import { highlight, lineCount } from '../../lib/highlight'

export interface CodeViewProps {
  /** Root-relative path, used to pick the language. */
  path: string
  content: string
  /** A 1-based line to mark and scroll into view (a search result). Scrolls when it or the path changes. */
  highlightLine?: number
}

export function CodeView({ path, content, highlightLine }: CodeViewProps): React.JSX.Element {
  const html = useMemo(() => highlight(path, content), [path, content])
  const lines = lineCount(content)
  const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n'), [lines])
  const mark = highlightLine !== undefined && highlightLine >= 1 && highlightLine <= lines ? highlightLine : undefined
  const markRef = useRef<HTMLDivElement>(null)

  // Not on content changes: a poll that brings new content must not pull the view back to the line.
  useEffect(() => {
    const el = markRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [path, mark])

  return (
    <div className="code-view">
      <pre className="code-gutter" aria-hidden="true">
        {gutter}
      </pre>
      <pre className="code-body">
        {html === null ? (
          <code className="hljs">{content}</code>
        ) : (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
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
