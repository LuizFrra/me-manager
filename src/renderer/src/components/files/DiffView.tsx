import { Fragment, useMemo, useState } from 'react'
import { parseUnifiedDiff, type DiffLine } from '../../lib/diff/parse'

export interface DiffViewProps {
  diff: string
}

/** Diffs with more lines than this are collapsed behind a button. */
const LARGE_DIFF_LINES = 5000

const ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'diff-add',
  del: 'diff-del',
  context: 'diff-context',
  note: 'diff-note',
}

export function DiffView({ diff }: DiffViewProps): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  // Remembers which diff text the user expanded, so a new diff starts collapsed again.
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)

  if (parsed.binary) return <div className="diff-view diff-message">Binary file changed.</div>
  if (parsed.hunks.length === 0) {
    if (parsed.renamed) return <div className="diff-view diff-message">Renamed from {parsed.oldPath}</div>
    return <div className="diff-view diff-message">No changes.</div>
  }

  if (parsed.lineCount > LARGE_DIFF_LINES && expandedDiff !== diff) {
    return (
      <div className="diff-view diff-large">
        <span>Large diff ({parsed.lineCount} lines)</span>{' '}
        <button type="button" onClick={() => setExpandedDiff(diff)}>
          Show diff anyway
        </button>
      </div>
    )
  }

  return (
    <div className="diff-view">
      {parsed.renamed && (
        <div className="diff-message">
          Renamed from {parsed.oldPath} to {parsed.newPath}
        </div>
      )}
      <table className="diff-table">
        <tbody>
          {parsed.hunks.map((hunk, h) => (
            <Fragment key={h}>
              <tr className="diff-hunk">
                <td colSpan={3}>{hunk.header}</td>
              </tr>
              {hunk.lines.map((line, i) => (
                <tr key={i} className={ROW_CLASS[line.kind]}>
                  <td className="diff-ln">{line.oldNo}</td>
                  <td className="diff-ln">{line.newNo}</td>
                  <td className="diff-text">{line.text}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
