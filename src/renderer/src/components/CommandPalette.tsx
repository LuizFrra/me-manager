import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { fuzzyFilter } from '../lib/fuzzy'
import { useRestoreFocus } from '../lib/useRestoreFocus'

export type PaletteKind = 'task' | 'folder' | 'action' | 'file'

export interface PaletteCommand {
  id: string
  kind: Exclude<PaletteKind, 'file'>
  label: string
  /** A keyboard shortcut shown next to an action. */
  shortcut?: string
}

/** One of the selected target's files; `label` is its path. */
interface FileEntry {
  id: string
  kind: 'file'
  label: string
  shortcut?: undefined
}

const isFile = (entry: PaletteCommand | FileEntry): entry is FileEntry => entry.kind === 'file'

export interface PaletteFiles {
  paths: string[]
  truncated: boolean
}

export const MAX_PALETTE_RESULTS = 50

const KIND_LABEL: Record<PaletteKind, string> = { task: 'Task', folder: 'Folder', action: 'Action', file: 'File' }
const KIND_ICON: Record<PaletteKind, string> = { task: '⎇', folder: '📁', action: '›', file: '📄' }

/** The label with its matched characters wrapped in <mark>. */
function Highlighted({ text, positions }: { text: string; positions: number[] }): React.JSX.Element {
  if (positions.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  const hit = new Set(positions)
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && hit.has(i) === hit.has(start)) continue
    const chunk = text.slice(start, i)
    parts.push(hit.has(start) ? <mark key={start}>{chunk}</mark> : chunk)
    start = i
  }
  return <>{parts}</>
}

/**
 * Fuzzy "go to anything": tasks, folders and actions, plus the selected target's files, which are fetched when
 * the palette opens and kept while it stays open. Enter or a click runs the active result; Esc closes.
 */
export function CommandPalette<C extends PaletteCommand>(props: {
  commands: C[]
  onRun: (command: C) => void
  /** Lists the selected target's files; undefined when nothing is selected. */
  loadFiles?: () => Promise<PaletteFiles>
  onOpenFile: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { commands, loadFiles, onRun, onOpenFile, onClose } = props
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [files, setFiles] = useState<PaletteFiles | null>(null)
  const [filesFailed, setFilesFailed] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()
  useRestoreFocus()

  useEffect(() => {
    if (!loadFiles) return
    let alive = true
    loadFiles().then(
      (list) => alive && setFiles(list),
      () => alive && setFilesFailed(true),
    )
    return () => {
      alive = false
    }
  }, [loadFiles])

  const fileEntries = useMemo<FileEntry[]>(
    () => (files?.paths ?? []).map((path) => ({ id: `file:${path}`, kind: 'file', label: path })),
    [files],
  )
  // Files only show up once the user types: an empty query lists tasks, folders and actions.
  const results = useMemo(
    () =>
      fuzzyFilter<C | FileEntry>(
        query.trim() ? [...commands, ...fileEntries] : commands,
        query,
        (c) => c.label,
        MAX_PALETTE_RESULTS,
      ),
    [commands, fileEntries, query],
  )
  const current = Math.min(active, results.length - 1)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [current, results])

  const run = (entry: C | FileEntry | undefined): void => {
    if (!entry) return
    onClose()
    if (isFile(entry)) onOpenFile(entry.label)
    else onRun(entry)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((current + step + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[current]?.item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const optionId = (i: number): string => `${listId}-${i}`
  const loadingFiles = Boolean(loadFiles) && !files && !filesFailed

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          role="combobox"
          aria-label="Search tasks, files and actions"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          placeholder="Go to a task, folder or file, or run an action…"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list" role="listbox" id={listId} aria-label="Results" ref={listRef}>
          {results.map(({ item, positions }, i) => (
            <li
              key={item.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              aria-label={item.label}
              className="palette-option"
              onMouseMove={() => i !== current && setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input
              onClick={() => run(item)}
            >
              <span className={`palette-icon palette-icon-${item.kind}`} aria-hidden="true">
                {KIND_ICON[item.kind]}
              </span>
              <span className="palette-label">
                <Highlighted text={item.label} positions={positions} />
              </span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
              <span className="palette-kind">{KIND_LABEL[item.kind]}</span>
            </li>
          ))}
        </ul>
        {results.length === 0 && <div className="palette-empty">No results</div>}
        <div className="palette-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span className="palette-footer-status">
            {loadingFiles
              ? 'Loading files…'
              : filesFailed
                ? 'Could not list files'
                : files?.truncated
                  ? 'File list truncated'
                  : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
