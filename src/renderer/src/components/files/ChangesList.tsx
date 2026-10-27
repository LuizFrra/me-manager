import { useMemo } from 'react'
import type { ChangedFile } from '../../../../shared/types'
import { STATUS_NAMES } from '../../lib/files'
import { VirtualRowList } from './VirtualRowList'

export interface ChangesListProps {
  changes: ChangedFile[]
  selected?: string
  onSelect: (path: string) => void
}

function splitPath(path: string): [dir: string, base: string] {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? ['', path] : [path.slice(0, slash + 1), path.slice(slash + 1)]
}

/** The changed files, one row each; only the rows in view are rendered once there are many. ↑/↓ move between them. */
export function ChangesList({ changes, selected, onSelect }: ChangesListProps): React.JSX.Element {
  const selectedIndex = useMemo(
    () => (selected ? changes.findIndex((c) => c.path === selected) : -1),
    [changes, selected],
  )
  if (changes.length === 0) return <p className="panel-hint">No changes yet.</p>
  const renderRow = (index: number, style: React.CSSProperties | undefined): React.ReactNode => {
    const c = changes[index]
    const [dir, base] = splitPath(c.path)
    const shownPath = c.oldPath ? `${c.oldPath} → ${c.path}` : c.path
    return (
      <button
        key={c.path}
        data-row={index}
        style={style}
        className={selected === c.path ? 'change-row selected' : 'change-row'}
        aria-current={selected === c.path ? 'true' : undefined}
        // The status in words, not its letter, as in the file tree.
        aria-label={`${shownPath}, ${STATUS_NAMES[c.status].toLowerCase()}, ${c.binary ? 'binary' : `+${c.added} −${c.removed}`}`}
        title={`${STATUS_NAMES[c.status]}: ${shownPath}`}
        onClick={() => onSelect(c.path)}
      >
        <span className={`badge badge-${c.status}`}>{c.status}</span>
        <span className="change-path">
          {c.oldPath ? (
            <>
              <span className="change-dir">{c.oldPath} → </span>
              {c.path}
            </>
          ) : (
            <>
              <span className="change-dir">{dir}</span>
              {base}
            </>
          )}
        </span>
        <span className="change-stat">
          {c.binary ? (
            'binary'
          ) : (
            <>
              <span className="stat-add">+{c.added}</span> <span className="stat-del">−{c.removed}</span>
            </>
          )}
        </span>
      </button>
    )
  }
  return (
    <VirtualRowList
      className="changes-list"
      label="Changed files"
      count={changes.length}
      selectedIndex={selectedIndex}
      selectedKey={selected}
      renderRow={renderRow}
    />
  )
}
