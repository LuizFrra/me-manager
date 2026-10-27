import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeList,
  ChangeStatus,
  FileContent,
  FileList,
  MeManagerApi,
  SearchMatch,
  Target,
} from '../../../../shared/types'
import { ancestorDirs, buildTree, filterPaths, flattenTree, memoByIdentity, sameFileList } from '../../lib/fileTree'
import { isSvgPath } from '../../../../shared/images'
import { folderIndex, isMarkdown } from '../../lib/files'
import { autoDiffLayout, loadDiffLayout, saveDiffLayout, type DiffLayout } from '../../lib/diff/layout'
import type { PanelState, PanelTab, SearchState } from '../../lib/panelState'
import { PANEL_SHORTCUT_LABEL } from '../../lib/shortcuts'
import { ChangesList } from './ChangesList'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { ReviewTray } from './ReviewTray'
import { SearchView } from './SearchView'
import type { LineRange, ReviewComment, ReviewDraft } from '../../lib/review'
import { cleanError } from '../../lib/toasts'
import { startVisibleInterval } from '../../lib/visibleInterval'
import { useLatestCallback } from '../../lib/useLatestCallback'

export interface SidePanelProps {
  api: MeManagerApi
  target: Target
  isRepo: boolean
  missing: boolean
  state: PanelState
  /** How often to refresh the changes, file list and open file; PANEL_POLL_MS by default. */
  pollMs?: number
  onState: (s: PanelState) => void
  onError: (e: unknown) => void
  onClose: () => void
  /**
   * Bumped (with `takeSearchFocus` then answering true once) when the app asks to focus the Search tab's input:
   * Mod+Shift+S or the palette.
   */
  searchFocus?: number
  takeSearchFocus?: () => boolean
  /** Review comments on this target's files (kept by App); lines can be commented on when given. */
  review?: SidePanelReview
}

/** The review tray's comments and actions (see ReviewTray), and what the viewer's "Comment" calls. */
export interface SidePanelReview {
  comments: readonly ReviewComment[]
  sending: boolean
  onComment: (draft: ReviewDraft, done: () => void) => void
  onEdit: (comment: ReviewComment) => void
  onDelete: (comment: ReviewComment) => void
  onSend: () => void
  onCopy: () => void
}

export const PANEL_POLL_MS = 3000
/** The file list is re-read every this many polls (and whenever the change list changes). */
const FILES_EVERY_N_POLLS = 5

type Alive = () => boolean
/** What the viewer shows for `key`: the file's content or diff, or why it couldn't be read. */
type Loaded = { key: string; value: FileContent | string; error?: undefined } | { key: string; error: string }

/** Stores the JSON of `value` under `slot`; true if it differs from what was stored before. */
function changed(cache: Map<string, string>, slot: string, value: unknown): boolean {
  const json = JSON.stringify(value)
  if (cache.get(slot) === json) return false
  cache.set(slot, json)
  return true
}

export function SidePanel(p: SidePanelProps): React.JSX.Element {
  const { api, target, isRepo, missing, state, onState, onError, pollMs = PANEL_POLL_MS } = p
  // Folders have no Changes tab.
  const tab: PanelTab = isRepo || state.tab !== 'changes' ? state.tab : 'files'

  const [fileList, setFileList] = useState<FileList | null>(null)
  const files = fileList?.paths ?? null
  const [changes, setChanges] = useState<ChangeList | null>(null)
  const [view, setView] = useState<Loaded | null>(null)
  const [stale, setStale] = useState(false)
  const [filter, setFilter] = useState('')
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [reload, setReload] = useState(0)
  // Last JSON per data slot, so polls that return the same data don't re-render.
  const lastJson = useRef(new Map<string, string>())

  // The diff layout: the user's last pick (kept for every target), else split when the panel is wide enough.
  const panelRef = useRef<HTMLDivElement>(null)
  const [pickedLayout, setPickedLayout] = useState<DiffLayout | null>(loadDiffLayout)
  const [fitLayout, setFitLayout] = useState<DiffLayout>('unified')
  // Measured before the first paint, so a wide panel doesn't flash a unified diff first.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const measure = (): void => setFitLayout(autoDiffLayout(el.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const diffLayout = pickedLayout ?? fitLayout
  const pickLayout = useLatestCallback((layout: DiffLayout): void => {
    setPickedLayout(layout)
    saveDiffLayout(layout)
  })

  // In Changes, only files in the change list have something to show; Search shows no file.
  const inChanges = Boolean(changes?.files.some((f) => f.path === state.selected))
  const shownPath = tab === 'search' || (tab === 'changes' && !inChanges) ? undefined : state.selected
  const viewKey = shownPath ? `${tab}:${shownPath}` : ''
  // For a rename, the diff is taken between the pair, so the backend doesn't have to find the rename again.
  const oldPath = tab === 'changes' ? changes?.files.find((f) => f.path === shownPath)?.oldPath : undefined

  // A poll that lists the same files keeps the old list, so the tree built from it isn't built again.
  const shownFiles = useRef<FileList | null>(null)
  const fetchFiles = useCallback(
    async (alive: Alive): Promise<void> => {
      const next = await api.listFiles(target)
      if (!alive() || sameFileList(shownFiles.current, next)) return
      shownFiles.current = next
      setFileList(next)
    },
    [api, target],
  )

  /** Resolves to true when the change list differs from the last one. */
  const fetchChanges = useCallback(
    async (alive: Alive): Promise<boolean> => {
      if (!isRepo) return false
      const next = await api.listChanges(target)
      if (!alive() || !changed(lastJson.current, 'changes', next)) return false
      setChanges(next)
      return true
    },
    [api, target, isRepo],
  )

  const fetchView = useCallback(
    async (alive: Alive): Promise<void> => {
      if (!shownPath) return
      const value =
        tab === 'files'
          ? await api.readFile(target, shownPath)
          : oldPath === undefined
            ? await api.fileDiff(target, shownPath)
            : await api.fileDiff(target, shownPath, oldPath)
      if (!alive()) return
      if (changed(lastJson.current, 'view', { key: viewKey, value })) setView({ key: viewKey, value })
      if (typeof value === 'object' && value.kind === 'missing') await fetchFiles(alive)
    },
    [api, target, tab, shownPath, oldPath, viewKey, fetchFiles],
  )

  // Initial load, and again on ⟳.
  useEffect(() => {
    if (missing) return
    let alive = true
    const isAlive = (): boolean => alive
    const report = (err: unknown): void => {
      if (alive) onError(err)
    }
    fetchFiles(isAlive).catch(report)
    fetchChanges(isAlive).catch(report)
    return () => {
      alive = false
    }
  }, [missing, fetchFiles, fetchChanges, onError, reload])

  // The selected file or diff, whenever the selection changes, and again on ⟳. A failure shows in the viewer (a
  // poll that reads it later replaces it).
  useEffect(() => {
    if (missing || !viewKey) return
    let alive = true
    fetchView(() => alive).catch((err) => {
      if (!alive) return
      lastJson.current.delete('view')
      setView({ key: viewKey, error: cleanError(err) })
    })
    return () => {
      alive = false
    }
  }, [missing, viewKey, fetchView, reload])

  // Polling while the panel is mounted (= open). Errors are silent and only mark ⟳ stale.
  useEffect(() => {
    if (missing) return
    let alive = true
    let ticks = 0
    const isAlive = (): boolean => alive
    const poll = async (): Promise<void> => {
      ticks++
      const listChanged = await fetchChanges(isAlive)
      await Promise.all([
        listChanged || ticks % FILES_EVERY_N_POLLS === 0 ? fetchFiles(isAlive) : undefined,
        fetchView(isAlive),
      ])
    }
    const stop = startVisibleInterval(
      () =>
        poll().then(
          () => alive && setStale(false),
          () => alive && setStale(true),
        ),
      pollMs,
    )
    return () => {
      alive = false
      stop()
    }
  }, [missing, fetchChanges, fetchFiles, fetchView, pollMs])

  const badges = useMemo(
    () => new Map<string, ChangeStatus>((changes?.files ?? []).map((f) => [f.path, f.status])),
    [changes],
  )
  // Derived data is rebuilt only when its input changes identity: the file list (kept across polls that return the
  // same files) or the filter. The tree is cached per list, so clearing the filter reuses the full tree.
  const matches = useMemo(() => (files ? filterPaths(files, filter) : []), [files, filter])
  const treeOf = useMemo(() => memoByIdentity((paths: readonly string[]) => buildTree(paths)), [])
  const tree = useMemo(() => treeOf(matches), [treeOf, matches])
  const selectedAncestors = useMemo(() => new Set(ancestorDirs(state.selected)), [state.selected])
  const filtering = filter.trim() !== ''
  // Stable, so the tree's rows are only flattened again when something about them changes.
  const isOpen = useCallback(
    (dir: string): boolean => filtering || (toggled.get(dir) ?? selectedAncestors.has(dir)),
    [filtering, toggled, selectedAncestors],
  )
  const toggleDir = useCallback(
    (dir: string): void => setToggled((prev) => new Map(prev).set(dir, !(prev.get(dir) ?? selectedAncestors.has(dir)))),
    [selectedAncestors],
  )

  const select = (nextTab: PanelTab, path: string): void =>
    onState({ ...state, tab: nextTab, selected: path, reveal: undefined, history: [] })
  // Stable identities for the viewer: a re-render here must not make MarkdownView remount its content.
  // A link to lines (`#L12`) opens the file at them; Markdown and SVG as their text, where lines can be shown. A link
  // to a heading (`#usage`) opens the file there. A link to a folder opens its README, as on GitHub.
  const openLink = useLatestCallback((link: string, lines?: LineRange, heading?: string): void => {
    const path = files && !lines && !files.includes(link) ? (folderIndex(files, link) ?? link) : link
    const scrollTop = panelRef.current?.querySelector('.viewer-body')?.scrollTop ?? 0
    onState({
      ...state,
      tab: 'files',
      selected: path,
      reveal: lines ? { path, lines: { ...lines } } : heading ? { path, heading } : undefined,
      history: state.selected
        ? [...state.history, { path: state.selected, scrollTop, mdMode: state.mdMode }]
        : state.history,
      mdMode: lines && (isMarkdown(path) || isSvgPath(path)) ? 'raw' : state.mdMode,
    })
  })
  // Back to the file where it was scrolled, as it was shown (a link to lines of a document showed that one raw).
  const back = useLatestCallback((): void => {
    const visit = state.history.at(-1)
    if (!visit) return
    const history = state.history.slice(0, -1)
    const { path, scrollTop, mdMode } = visit
    onState({
      ...state,
      tab: 'files',
      selected: path,
      reveal: scrollTop > 0 ? { path, scrollTop } : undefined,
      history,
      mdMode,
    })
  })
  // A search result opens in Files at its line; Markdown and SVG as their text, where lines can be shown.
  const openMatch = useLatestCallback((m: SearchMatch): void => {
    setFilter('')
    onState({
      ...state,
      tab: 'files',
      selected: m.path,
      reveal: { path: m.path, lines: { start: m.line, end: m.line } },
      history: [],
      mdMode: isMarkdown(m.path) || isSvgPath(m.path) ? 'raw' : state.mdMode,
    })
  })
  // A comment opens at its lines, where it was made: the diff, or the file (Markdown and SVG as their text).
  const openComment = (c: ReviewComment): void => {
    const inFiles = c.tab === 'files' || !isRepo
    onState({
      ...state,
      tab: inFiles ? 'files' : 'changes',
      selected: c.path,
      // New objects: a click on the same comment again scrolls back to its lines.
      reveal: inFiles
        ? { path: c.path, lines: { ...((c.lines ?? c.removed) as LineRange) } }
        : { path: c.path, lines: c.lines && { ...c.lines }, removed: c.removed && { ...c.removed } },
      history: [],
      mdMode: inFiles && (isMarkdown(c.path) || isSvgPath(c.path)) ? 'raw' : state.mdMode,
    })
  }
  const tabsRef = useRef<HTMLDivElement>(null)
  const { review } = p
  const deleteComment = (c: ReviewComment): void => {
    // The tray goes away with its last comment: focus would be lost with it.
    if (review?.comments.length === 1 && document.activeElement?.closest('.review-tray')) {
      tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    }
    review?.onDelete(c)
  }
  const setSearch = useLatestCallback((search: SearchState): void => onState({ ...state, search }))
  // Focus requests for the search input: the app's (shortcut, palette) and a click on the Search tab.
  const [tabFocus, setTabFocus] = useState(0)
  const tabFocusPending = useRef(false)
  const { takeSearchFocus } = p
  const takeFocus = useCallback((): boolean => {
    const own = tabFocusPending.current
    tabFocusPending.current = false
    return (takeSearchFocus?.() ?? false) || own
  }, [takeSearchFocus])
  const setMdMode = useLatestCallback((mdMode: PanelState['mdMode']): void => onState({ ...state, mdMode }))
  const openFile = useLatestCallback((path: string): void => select('files', path))

  const shown = view && view.key === viewKey ? view : undefined
  const loaded = shown?.error === undefined ? shown?.value : undefined
  const change = tab === 'changes' ? changes?.files.find((f) => f.path === shownPath) : undefined

  return (
    <div className="panel" ref={panelRef}>
      <div className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="Side panel" ref={tabsRef}>
          <button role="tab" aria-selected={tab === 'files'} onClick={() => onState({ ...state, tab: 'files' })}>
            Files
          </button>
          {isRepo && (
            <button role="tab" aria-selected={tab === 'changes'} onClick={() => onState({ ...state, tab: 'changes' })}>
              Changes {changes && <span className="panel-count">{changes.files.length}</span>}
            </button>
          )}
          <button
            role="tab"
            aria-selected={tab === 'search'}
            onClick={() => {
              tabFocusPending.current = true
              setTabFocus((n) => n + 1)
              onState({ ...state, tab: 'search' })
            }}
          >
            Search
          </button>
        </div>
        <div className="panel-actions">
          <button
            className="panel-icon"
            aria-label={stale ? 'Refresh (last refresh failed)' : 'Refresh'}
            title={stale ? 'Refresh — the last automatic refresh failed' : 'Refresh'}
            onClick={() => {
              setStale(false)
              setReload((n) => n + 1)
            }}
          >
            ⟳{stale && <span className="stale-dot" />}
          </button>
          <button
            className="panel-icon"
            aria-label="Close files panel"
            title={`Close (${PANEL_SHORTCUT_LABEL})`}
            onClick={p.onClose}
          >
            ✕
          </button>
        </div>
      </div>
      {review && review.comments.length > 0 && (
        <ReviewTray
          comments={review.comments}
          sending={review.sending}
          onOpen={openComment}
          onEdit={review.onEdit}
          onDelete={deleteComment}
          onSend={review.onSend}
          onCopy={review.onCopy}
        />
      )}
      {missing ? (
        <div className="panel-missing" role="status">
          ⚠ This task&apos;s folder is missing.
        </div>
      ) : tab === 'search' ? (
        <div className="panel-body">
          <SearchView
            api={api}
            target={target}
            state={state.search}
            onState={setSearch}
            onOpen={openMatch}
            reload={reload}
            focusSeq={(p.searchFocus ?? 0) + tabFocus}
            takeFocus={takeFocus}
          />
        </div>
      ) : (
        <div className="panel-body">
          <div className="panel-list">
            {tab === 'files' ? (
              <>
                <input
                  className="panel-filter"
                  aria-label="Filter files"
                  placeholder="Filter files…"
                  spellCheck={false}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setFilter('')
                    else if (e.key === 'ArrowDown') {
                      const row = panelRef.current?.querySelector<HTMLElement>('.file-tree [data-row]')
                      if (row) {
                        e.preventDefault()
                        row.focus()
                      }
                    } else if (e.key === 'Enter' && filtering) {
                      // The first file the narrowed tree shows.
                      const first = flattenTree(tree, isOpen).find((r) => !r.node.dir)
                      if (first) select('files', first.node.path)
                    }
                  }}
                />
                <div className="panel-list-scroll">
                  {fileList?.truncated && (
                    <div className="panel-notice">
                      Showing the first {fileList.paths.length.toLocaleString('en-US')} files.
                    </div>
                  )}
                  {files === null ? (
                    <p className="panel-hint">Loading…</p>
                  ) : files.length === 0 ? (
                    <p className="panel-hint">No files.</p>
                  ) : matches.length === 0 ? (
                    <p className="panel-hint">No files match.</p>
                  ) : (
                    <FileTree
                      nodes={tree}
                      selected={state.selected}
                      badges={badges}
                      isOpen={isOpen}
                      onToggle={toggleDir}
                      onSelect={(path) => select('files', path)}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="panel-list-scroll">
                {changes?.fallback && (
                  <div className="panel-notice">Base branch not found — showing uncommitted changes only.</div>
                )}
                {changes === null ? (
                  <p className="panel-hint">Loading…</p>
                ) : (
                  <ChangesList
                    changes={changes.files}
                    selected={shownPath}
                    onSelect={(path) => select('changes', path)}
                  />
                )}
              </div>
            )}
          </div>
          <FileViewer
            api={api}
            target={target}
            tab={tab}
            path={shownPath}
            content={tab === 'files' && typeof loaded === 'object' ? loaded : undefined}
            diff={tab === 'changes' && typeof loaded === 'string' ? loaded : undefined}
            change={change}
            error={shown?.error}
            mdMode={state.mdMode}
            diffLayout={diffLayout}
            onDiffLayout={pickLayout}
            reveal={state.reveal?.path === shownPath ? state.reveal : undefined}
            canGoBack={state.history.length > 0}
            onBack={back}
            onMdMode={setMdMode}
            onOpenLink={openLink}
            onOpenFile={openFile}
            onError={onError}
            onComment={review?.onComment}
          />
        </div>
      )}
    </div>
  )
}
