import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Folder, GitBranch, type LucideIcon } from 'lucide-react'
import { fuzzyFilter } from '../lib/fuzzy'
import { ICON } from '../lib/icon'
import { useRestoreFocus } from '../lib/useRestoreFocus'

export type PaletteKind = 'task' | 'folder' | 'action' | 'file'

export interface PaletteCommand {
  id: string
  kind: Exclude<PaletteKind, 'file'>
  label: string
  /** A keyboard shortcut shown next to an action. */
  shortcut?: string
  /** An emoji shown in place of the kind's icon: a task's or folder's theme icon. */
  icon?: string
}

/** One of the selected target's files; `label` is its path. */
interface FileEntry {
  id: string
  kind: 'file'
  label: string
  shortcut?: undefined
  icon?: undefined
}

const isFile = (entry: PaletteCommand | FileEntry): entry is FileEntry => entry.kind === 'file'

export interface PaletteFiles {
  paths: string[]
  truncated: boolean
}

export const MAX_PALETTE_RESULTS = 50

const KIND_LABEL: Record<PaletteKind, string> = { task: 'Task', folder: 'Folder', action: 'Action', file: 'File' }
const KIND_ICON: Record<PaletteKind, LucideIcon> = {
  task: GitBranch,
  folder: Folder,
  action: ChevronRight,
  file: FileText,
}

/** The kind's line icon, or the theme's emoji when it has one. */
function KindIcon({ kind, emoji }: { kind: PaletteKind; emoji?: string }): React.JSX.Element {
  if (emoji) return <>{emoji}</>
  const Icon = KIND_ICON[kind]
  return <Icon {...ICON} />
}

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
 * A file's path as its name, then its folder, dimmed: a long path cut at its end would hide the name. The matched
 * characters are highlighted in both.
 */
function FileLabel({ path, positions }: { path: string; positions: number[] }): React.JSX.Element {
  const start = path.lastIndexOf('/') + 1
  const name = path.slice(start)
  const folder = path.slice(0, Math.max(0, start - 1))
  return (
    <>
      <span className="palette-file-name">
        <Highlighted text={name} positions={positions.filter((p) => p >= start).map((p) => p - start)} />
      </span>
      {folder && (
        <span className="palette-file-dir">
          <Highlighted text={folder} positions={positions.filter((p) => p < folder.length)} />
        </span>
      )}
    </>
  )
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
  // The highlighted result, by id: when the results change under it (the files arrive), it stays the same result.
  // Null: the first one.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [files, setFiles] = useState<PaletteFiles | null>(null)
  const [filesFailed, setFilesFailed] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()
  // The result highlighted on screen, for when the files arrive: see loadFiles below.
  const shownActive = useRef<string | null>(null)
  // Whether the next change of highlight scrolls it into view: not when the pointer made it, as a row half out of
  // view would scroll from under the pointer, leaving it over another row.
  const scrollToActive = useRef(true)
  useRestoreFocus()

  useEffect(() => {
    if (!loadFiles) return
    let alive = true
    loadFiles().then(
      (list) => {
        if (!alive) return
        // Files may rank above what is highlighted: keep that highlighted, so Enter opens what the user saw.
        setActiveId((id) => id ?? shownActive.current)
        setFiles(list)
      },
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
  const current =
    results.length === 0
      ? -1
      : Math.max(
          0,
          results.findIndex((r) => r.item.id === activeId),
        )

  useEffect(() => {
    shownActive.current = results[current]?.item.id ?? null
    if (scrollToActive.current) {
      const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      el?.scrollIntoView?.({ block: 'nearest' })
    }
    scrollToActive.current = true
  }, [current, results])

  const run = (entry: C | FileEntry | undefined): void => {
    if (!entry) return
    onClose()
    if (isFile(entry)) onOpenFile(entry.label)
    else onRun(entry)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // An input method (Japanese, Chinese…) uses these keys to pick, confirm or cancel what it composes.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveId(results[(current + step + results.length) % results.length].item.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[current]?.item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      e.preventDefault() // the input is the palette's one control: the focus has nowhere to go
    }
  }

  const optionId = (i: number): string => `${listId}-${i}`
  const loadingFiles = Boolean(loadFiles) && !files && !filesFailed

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // A click anywhere in it (a result, the footer) keeps the focus in the input, where the palette's keys work.
        onMouseDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}
      >
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
            setActiveId(null)
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
              title={item.label}
              className="palette-option"
              onMouseMove={() => {
                if (i === current) return
                scrollToActive.current = false
                setActiveId(item.id)
              }}
              onClick={() => run(item)}
            >
              <span
                className={`palette-icon palette-icon-${item.kind}${item.icon ? ' palette-icon-theme' : ''}`}
                aria-hidden="true"
              >
                <KindIcon kind={item.kind} emoji={item.icon} />
              </span>
              <span className="palette-label">
                {isFile(item) ? (
                  <FileLabel path={item.label} positions={positions} />
                ) : (
                  <Highlighted text={item.label} positions={positions} />
                )}
              </span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
              <span className="palette-kind">{KIND_LABEL[item.kind]}</span>
            </li>
          ))}
        </ul>
        {/* Status regions, there before what they say, so screen readers hear it from the combobox. */}
        <div className="palette-empty" role="status">
          {results.length === 0 ? 'No results' : ''}
        </div>
        <div className="palette-footer">
          <span aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span aria-hidden="true">
            <kbd>Enter</kbd> open
          </span>
          <span aria-hidden="true">
            <kbd>Esc</kbd> close
          </span>
          <span className="palette-footer-status" role="status">
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
