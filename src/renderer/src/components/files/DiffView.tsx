import { Fragment, useId, useMemo, useRef, useState } from 'react'
import { parseUnifiedDiff, type DiffLine, type ParsedDiff } from '../../lib/diff/parse'
import type { DiffLayout } from '../../lib/diff/layout'
import { splitHunks, type SplitCell } from '../../lib/diff/split'
import {
  LINE_SELECT_HINT,
  selectionBounds,
  useLineSelect,
  type LineSelection,
  type LineSelectProps,
} from '../../lib/lineSelection'
import { diffLinesRange } from '../../lib/review'

export interface DiffViewProps {
  diff: string
  /** One column (the default), or old on the left and new on the right. */
  layout?: DiffLayout
  /**
   * Lines can be selected by their numbers, for a review comment. Rows are indexed in the unified order, notes
   * left out, so a selection means the same lines in either layout.
   */
  select?: LineSelectProps
}

/** The lines that can be selected (all but notes), in order, and where each one is by line object and number. */
interface Selectable {
  lines: DiffLine[]
  index: Map<DiffLine, number>
  /** By old line number (deleted and unchanged lines) and by new one (added and unchanged lines). */
  byOld: Map<number, number>
  byNew: Map<number, number>
}

function selectableLines(parsed: ParsedDiff): Selectable {
  const out: Selectable = { lines: [], index: new Map(), byOld: new Map(), byNew: new Map() }
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'note') continue
      const i = out.lines.push(line) - 1
      out.index.set(line, i)
      if (line.oldNo !== undefined) out.byOld.set(line.oldNo, i)
      if (line.newNo !== undefined) out.byNew.set(line.newNo, i)
    }
  }
  return out
}

/** Diffs with more lines than this are collapsed behind a button, in either layout. */
const LARGE_DIFF_LINES = 5000

const ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'diff-add',
  del: 'diff-del',
  context: 'diff-context',
  note: 'diff-note',
}

/**
 * One side of a split row: its line number and text, or two empty cells when the side has no line there. `sel` is
 * the line's selectable row, when lines can be selected.
 */
function SplitSide({
  cell,
  sel,
  selected,
}: {
  cell: SplitCell | null
  sel?: number
  selected: boolean
}): React.JSX.Element {
  const cls = `${cell ? ROW_CLASS[cell.kind] : 'diff-empty'}${selected ? ' diff-selected' : ''}`
  return (
    <>
      <td className={`diff-ln ${cls}`} data-sel={sel}>
        {cell?.no}
      </td>
      <td className={`diff-text ${cls}`}>{cell?.text}</td>
    </>
  )
}

/** The selectable row a line-number cell stands for, if the event happened in one. */
const pickedRow = (e: React.MouseEvent): number | null => {
  const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('td[data-sel]') : null
  return cell ? Number(cell.dataset.sel) : null
}

export function DiffView({ diff, layout = 'unified', select }: DiffViewProps): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  const split = useMemo(() => (layout === 'split' ? splitHunks(parsed.hunks) : null), [layout, parsed])
  // Remembers which diff text the user expanded, so a new diff starts collapsed again.
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)

  const selectable = useMemo(() => selectableLines(parsed), [parsed])
  const tableRef = useRef<HTMLTableElement>(null)
  const hintId = useId()
  const linesFor = (s: LineSelection): ReturnType<typeof diffLinesRange> => {
    const [first, last] = selectionBounds(s)
    return diffLinesRange(selectable.lines.slice(first, last + 1))
  }
  const { onKeyDown, pick } = useLineSelect(select, selectable.lines.length, linesFor, (index) => {
    const cell = tableRef.current?.querySelector(`[data-sel="${index}"]`)
    if (cell && typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  const [low, high] = select?.selection ? selectionBounds(select.selection) : [-1, -2]
  const isSelected = (i: number | undefined): boolean => i !== undefined && i >= low && i <= high
  // Line numbers are clicked (Shift extends); the table takes focus for the keys. Shift-clicks would select text.
  const selectProps = select && {
    ref: tableRef,
    tabIndex: 0,
    'data-line-select': true,
    'aria-describedby': hintId,
    onKeyDown,
    onMouseDown: (e: React.MouseEvent) => {
      if (e.shiftKey && pickedRow(e) !== null) e.preventDefault()
    },
    onClick: (e: React.MouseEvent<HTMLTableElement>) => {
      const row = pickedRow(e)
      if (row === null) return
      e.currentTarget.focus({ preventScroll: true })
      pick(row, e.shiftKey)
    },
  }
  const sideSel = (cell: SplitCell | null, by: Map<number, number>): number | undefined =>
    select && cell && cell.kind !== 'note' && cell.no !== undefined ? by.get(cell.no) : undefined

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
      {select && (
        <span id={hintId} hidden>
          {LINE_SELECT_HINT}
        </span>
      )}
      {split ? (
        <table className="diff-table diff-split" aria-label="Side-by-side diff" {...selectProps}>
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
                {hunk.rows.map((row, i) => {
                  const left = sideSel(row.left, selectable.byOld)
                  const right = sideSel(row.right, selectable.byNew)
                  return (
                    <tr key={i}>
                      <SplitSide cell={row.left} sel={left} selected={isSelected(left)} />
                      <SplitSide cell={row.right} sel={right} selected={isSelected(right)} />
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="diff-table diff-unified" aria-label="Diff" {...selectProps}>
          <tbody>
            {parsed.hunks.map((hunk, h) => (
              <Fragment key={h}>
                <tr className="diff-hunk">
                  <td colSpan={3}>{hunk.header}</td>
                </tr>
                {hunk.lines.map((line, i) => {
                  const sel = select ? selectable.index.get(line) : undefined
                  return (
                    <tr key={i} className={`${ROW_CLASS[line.kind]}${isSelected(sel) ? ' diff-selected' : ''}`}>
                      <td className="diff-ln" data-sel={sel}>
                        {line.oldNo}
                      </td>
                      <td className="diff-ln" data-sel={sel}>
                        {line.newNo}
                      </td>
                      <td className="diff-text">{line.text}</td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
