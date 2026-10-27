import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { modeChangeText, parseUnifiedDiff, type DiffLine, type ParsedDiff } from '../../lib/diff/parse'
import type { DiffLayout } from '../../lib/diff/layout'
import { splitHunks, type SplitCell, type SplitHunk, type SplitRow } from '../../lib/diff/split'
import {
  LINE_SELECT_HINT,
  selectionBounds,
  useLineSelect,
  type LineSelection,
  type LineSelectProps,
} from '../../lib/lineSelection'
import { diffLinesRange } from '../../lib/review'
import { useVirtualRows } from '../../lib/useVirtualRows'

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

/**
 * Diffs with more lines than this are collapsed behind a button, in either layout. Only the rows in view are
 * rendered, so this is about parsing and laying them out, which takes some 25 ms at 50,000 lines.
 */
const LARGE_DIFF_LINES = 50_000

/** The height of every row of a long diff, hunk headers included, in px (the 18 px lines of `.diff-table`). */
export const DIFF_ROW_HEIGHT = 18

/**
 * A row of the table: a hunk's header, a line (unified), or a line of each side (split). `sel`, `left` and `right`
 * are the selectable rows of its lines, if any.
 */
type DiffRow =
  | { kind: 'hunk'; header: string }
  | { kind: 'line'; line: DiffLine; sel?: number }
  | { kind: 'pair'; row: SplitRow; left?: number; right?: number }

interface TableRows {
  rows: DiffRow[]
  /** The table row of each selectable line (an unchanged line's, in the split layout). */
  rowOf: number[]
  /**
   * The most digits a line number has and (unified) the longest line, tabs as 4, in characters: how wide the
   * columns are, whichever rows are rendered.
   */
  digits: number
  longest: number
}

const sideSel = (cell: SplitCell | null, by: Map<number, number>): number | undefined =>
  cell && cell.kind !== 'note' && cell.no !== undefined ? by.get(cell.no) : undefined

/** The rows of the table, in either layout (`split` when split). */
function tableRows(parsed: ParsedDiff, split: SplitHunk[] | null, selectable: Selectable): TableRows {
  const out: TableRows = { rows: [], rowOf: [], digits: 1, longest: 0 }
  const at = (sel: number | undefined): void => {
    if (sel !== undefined && out.rowOf[sel] === undefined) out.rowOf[sel] = out.rows.length
  }
  const fit = (text: string): void => {
    let tabs = 0
    for (let i = text.indexOf('\t'); i !== -1; i = text.indexOf('\t', i + 1)) tabs++
    out.longest = Math.max(out.longest, text.length + 3 * tabs)
  }
  if (split) {
    for (const hunk of split) {
      out.rows.push({ kind: 'hunk', header: hunk.header })
      for (const row of hunk.rows) {
        const left = sideSel(row.left, selectable.byOld)
        const right = sideSel(row.right, selectable.byNew)
        at(left)
        at(right)
        out.rows.push({ kind: 'pair', row, left, right })
      }
    }
  } else {
    for (const hunk of parsed.hunks) {
      out.rows.push({ kind: 'hunk', header: hunk.header })
      fit(hunk.header)
      for (const line of hunk.lines) {
        const sel = selectable.index.get(line)
        at(sel)
        out.rows.push({ kind: 'line', line, sel })
        fit(line.text)
      }
    }
  }
  for (const line of selectable.lines) {
    out.digits = Math.max(out.digits, String(line.oldNo ?? 0).length, String(line.newNo ?? 0).length)
  }
  return out
}

const ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'diff-add',
  del: 'diff-del',
  context: 'diff-context',
  note: 'diff-note',
}

/**
 * One side of a split row: its line number and text, or two empty cells when the side has no line there. `sel` is
 * the line's selectable row, when lines can be selected. `clipped`: long lines are cut short rather than wrapped
 * (to keep the rows of a long diff one line high), with the whole line in a tooltip.
 */
function SplitSide({
  cell,
  sel,
  selected,
  clipped,
}: {
  cell: SplitCell | null
  sel?: number
  selected: boolean
  clipped: boolean
}): React.JSX.Element {
  const cls = `${cell ? ROW_CLASS[cell.kind] : 'diff-empty'}${selected ? ' diff-selected' : ''}`
  return (
    <>
      <td className={`diff-ln ${cls}`} data-sel={sel}>
        {cell?.no}
      </td>
      <td className={`diff-text ${cls}`} title={clipped && cell?.text ? cell.text : undefined}>
        {cell?.text}
      </td>
    </>
  )
}

/** An empty row standing for `rows` rows left out of a long diff, keeping the table's height. */
const Spacer = ({ rows, cols }: { rows: number; cols: number }): React.JSX.Element | null =>
  rows > 0 ? (
    <tr className="diff-spacer" aria-hidden="true" style={{ height: rows * DIFF_ROW_HEIGHT }}>
      <td colSpan={cols} />
    </tr>
  ) : null

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
  const table = useMemo(() => tableRows(parsed, split, selectable), [parsed, split, selectable])
  // A long diff renders the rows in view of the viewer's body (its scroller), all one line high.
  const { setContainer, virtual, start, end, scrollToIndex } = useVirtualRows<HTMLTableSectionElement>({
    count: table.rows.length,
    rowHeight: DIFF_ROW_HEIGHT,
    scrollParent: true,
  })
  const tableRef = useRef<HTMLTableElement>(null)
  const hintId = useId()
  const linesFor = (s: LineSelection): ReturnType<typeof diffLinesRange> => {
    const [first, last] = selectionBounds(s)
    return diffLinesRange(selectable.lines.slice(first, last + 1))
  }
  // The line the selection moved to, scrolled into view once it is rendered: it may be out of the rows rendered.
  const pendingScroll = useRef<number | null>(null)
  const scrollToLine = (index: number): boolean => {
    const cell = tableRef.current?.querySelector(`[data-sel="${index}"]`)
    if (!cell) return false
    if (typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return true
  }
  const { onKeyDown, pick } = useLineSelect(select, selectable.lines.length, linesFor, (index) => {
    if (virtual) scrollToIndex(table.rowOf[index])
    pendingScroll.current = scrollToLine(index) ? null : index
  })
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollToLine(pendingScroll.current)) pendingScroll.current = null
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

  const modeChange = modeChangeText(parsed)
  if (parsed.binary || parsed.hunks.length === 0) {
    // No lines to show: what happened to the file as a whole. An empty file added or deleted has no lines either.
    const what = parsed.binary
      ? `Binary file ${parsed.status ?? 'changed'}.`
      : parsed.renamed
        ? `Renamed from ${parsed.oldPath}`
        : parsed.status
          ? `Empty file ${parsed.status}.`
          : modeChange
            ? null
            : 'No changes.'
    if (!modeChange) return <div className="diff-view diff-message">{what}</div>
    return (
      <div className="diff-view">
        {what && <div className="diff-message">{what}</div>}
        <div className="diff-message">{modeChange}</div>
      </div>
    )
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

  const cols = split ? 4 : 3
  const shown: React.ReactNode[] = []
  for (let i = start; i < end; i++) {
    const row = table.rows[i]
    // Rows are counted from 1, for assistive technology, when only some are in the table.
    const index = virtual ? i + 1 : undefined
    if (row.kind === 'hunk') {
      shown.push(
        <tr key={i} className="diff-hunk" aria-rowindex={index}>
          <td colSpan={cols}>{row.header}</td>
        </tr>,
      )
    } else if (row.kind === 'pair') {
      const left = select ? row.left : undefined
      const right = select ? row.right : undefined
      shown.push(
        <tr key={i} aria-rowindex={index}>
          <SplitSide cell={row.row.left} sel={left} selected={isSelected(left)} clipped={virtual} />
          <SplitSide cell={row.row.right} sel={right} selected={isSelected(right)} clipped={virtual} />
        </tr>,
      )
    } else {
      const { line } = row
      const sel = select ? row.sel : undefined
      shown.push(
        <tr
          key={i}
          className={`${ROW_CLASS[line.kind]}${isSelected(sel) ? ' diff-selected' : ''}`}
          aria-rowindex={index}
        >
          <td className="diff-ln" data-sel={sel}>
            {line.oldNo}
          </td>
          <td className="diff-ln" data-sel={sel}>
            {line.newNo}
          </td>
          <td className="diff-text">{line.text}</td>
        </tr>,
      )
    }
  }
  const body = (
    <tbody ref={setContainer}>
      <Spacer rows={start} cols={cols} />
      {shown}
      <Spacer rows={table.rows.length - end} cols={cols} />
    </tbody>
  )
  // The columns are as wide as the widest line number and line, not just of the rows rendered, so that they
  // don't change as the diff is scrolled.
  const virtualProps = virtual && {
    'aria-rowcount': table.rows.length,
    style: { '--diff-ln-ch': table.digits, '--diff-text-ch': table.longest } as React.CSSProperties,
  }
  const virtualClass = virtual ? ' diff-virtual' : ''

  return (
    <div className={`diff-view${split ? ' diff-view-split' : ''}`}>
      {parsed.renamed && (
        <div className="diff-message">
          Renamed from {parsed.oldPath} to {parsed.newPath}
        </div>
      )}
      {modeChange && <div className="diff-message">{modeChange}</div>}
      {select && (
        <span id={hintId} hidden>
          {LINE_SELECT_HINT}
        </span>
      )}
      {split ? (
        <table
          className={`diff-table diff-split${virtualClass}`}
          aria-label="Side-by-side diff"
          {...virtualProps}
          {...selectProps}
        >
          <colgroup>
            <col className="diff-col-ln" />
            <col />
            <col className="diff-col-ln" />
            <col />
          </colgroup>
          {body}
        </table>
      ) : (
        <table
          className={`diff-table diff-unified${virtualClass}`}
          aria-label="Diff"
          {...virtualProps}
          {...selectProps}
        >
          {body}
        </table>
      )}
    </div>
  )
}
