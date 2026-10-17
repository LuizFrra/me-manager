import { useMemo } from 'react'
import { highlight, lineCount } from '../../lib/highlight'

export interface CodeViewProps {
  /** Root-relative path, used to pick the language. */
  path: string
  content: string
}

export function CodeView({ path, content }: CodeViewProps): React.JSX.Element {
  const html = useMemo(() => highlight(path, content), [path, content])
  const gutter = useMemo(
    () => Array.from({ length: lineCount(content) }, (_, i) => String(i + 1)).join('\n'),
    [content],
  )
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
    </div>
  )
}
