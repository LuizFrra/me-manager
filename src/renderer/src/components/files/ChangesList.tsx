import type { ChangedFile } from '../../../../shared/types'
import { STATUS_NAMES } from '../../lib/files'

export interface ChangesListProps {
  changes: ChangedFile[]
  selected?: string
  onSelect: (path: string) => void
}

function splitPath(path: string): [dir: string, base: string] {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? ['', path] : [path.slice(0, slash + 1), path.slice(slash + 1)]
}

export function ChangesList({ changes, selected, onSelect }: ChangesListProps): React.JSX.Element {
  if (changes.length === 0) return <p className="panel-hint">No changes yet.</p>
  return (
    <div className="changes-list">
      {changes.map((c) => {
        const [dir, base] = splitPath(c.path)
        return (
          <button
            key={c.path}
            className={selected === c.path ? 'change-row selected' : 'change-row'}
            aria-current={selected === c.path ? 'true' : undefined}
            title={`${STATUS_NAMES[c.status]}: ${c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}`}
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
      })}
    </div>
  )
}
