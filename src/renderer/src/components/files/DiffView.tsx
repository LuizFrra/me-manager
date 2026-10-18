import { Fragment, useMemo, useState } from 'react'
import { parseUnifiedDiff, type DiffLine } from '../../lib/diff/parse'
import type { DiffLayout } from '../../lib/diff/layout'
import { splitHunks, type SplitCell } from '../../lib/diff/split'

export interface DiffViewProps {
  diff: string
  /** One column (the default), or old on the left and new on the right. */
  layout?: DiffLayout
}

/** Diffs with more lines than this are collapsed behind a button, in either layout. */
const LARGE_DIFF_LINES = 5000

const ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'diff-add',
  del: 'diff-del',
  context: 'diff-context',
  note: 'diff-note',
}

/** One side of a split row: its line number and text, or two empty cells when the side has no line there. */
function SplitSide({ cell }: { cell: SplitCell | null }): React.JSX.Element {
  const cls = cell ? ROW_CLASS[cell.kind] : 'diff-empty'
  return (
    <>
      <td className={`diff-ln ${cls}`}>{cell?.no}</td>
      <td className={`diff-text ${cls}`}>{cell?.text}</td>
    </>
  )
}

export function DiffView({ diff, layout = 'unified' }: DiffViewProps): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  const split = useMemo(() => (layout === 'split' ? splitHunks(parsed.hunks) : null), [layout, parsed])
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
    <div className={`diff-view${split ? ' diff-view-split' : ''}`}>
      {parsed.renamed && (
        <div className="diff-message">
          Renamed from {parsed.oldPath} to {parsed.newPath}
        </div>
      )}
      {split ? (
        <table className="diff-table diff-split" aria-label="Side-by-side diff">
          <colgroup>
            <col className="diff-col-ln" />
            <col />
            <col className="diff-col-ln" />
            <col />
          </colgroup>
          <tbody>
            {split.map((hunk, h) => (
              <Fragment key={h}>
                <tr className="diff-hunk">
                  <td colSpan={4}>{hunk.header}</td>
                </tr>
                {hunk.rows.map((row, i) => (
                  <tr key={i}>
                    <SplitSide cell={row.left} />
                    <SplitSide cell={row.right} />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="diff-table diff-unified">
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
      )}
    </div>
  )
}
