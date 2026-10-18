import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeList, ChangeStatus, FileContent, MeManagerApi, Target } from '../../../../shared/types'
import { ancestorDirs, buildTree, filterPaths } from '../../lib/fileTree'
import type { PanelState, PanelTab } from '../../lib/panelState'
import { PANEL_SHORTCUT_LABEL } from '../../lib/shortcuts'
import { ChangesList } from './ChangesList'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { startVisibleInterval } from '../../lib/visibleInterval'
import { useLatestCallback } from '../../lib/useLatestCallback'

export interface SidePanelProps {
  api: MeManagerApi
  target: Target
  isRepo: boolean
  missing: boolean
  state: PanelState
  onState: (s: PanelState) => void
  onError: (e: unknown) => void
  onClose: () => void
}

export const PANEL_POLL_MS = 3000
/** The file list is re-read every this many polls (and whenever the change list changes). */
const FILES_EVERY_N_POLLS = 5
const MAX_TREE_MATCHES = 2000

type Alive = () => boolean
interface Loaded {
  key: string
  value: FileContent | string
}

/** Stores the JSON of `value` under `slot`; true if it differs from what was stored before. */
function changed(cache: Map<string, string>, slot: string, value: unknown): boolean {
  const json = JSON.stringify(value)
  if (cache.get(slot) === json) return false
  cache.set(slot, json)
  return true
}

export function SidePanel(p: SidePanelProps): React.JSX.Element {
  const { api, target, isRepo, missing, state, onState, onError } = p
  const tab: PanelTab = isRepo ? state.tab : 'files'

  const [files, setFiles] = useState<string[] | null>(null)
  const [changes, setChanges] = useState<ChangeList | null>(null)
  const [view, setView] = useState<Loaded | null>(null)
  const [stale, setStale] = useState(false)
  const [filter, setFilter] = useState('')
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [reload, setReload] = useState(0)
  // Last JSON per data slot, so polls that return the same data don't re-render.
  const lastJson = useRef(new Map<string, string>())

  // In Changes, only files in the change list have something to show.
  const inChanges = Boolean(changes?.files.some((f) => f.path === state.selected))
  const shownPath = tab === 'changes' && !inChanges ? undefined : state.selected
  const viewKey = shownPath ? `${tab}:${shownPath}` : ''
  // For a rename, the diff is taken between the pair, so the backend doesn't have to find the rename again.
  const oldPath = tab === 'changes' ? changes?.files.find((f) => f.path === shownPath)?.oldPath : undefined

  const fetchFiles = useCallback(
    async (alive: Alive): Promise<void> => {
      const next = await api.listFiles(target)
      if (alive() && changed(lastJson.current, 'files', next)) setFiles(next)
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

  // The selected file or diff, whenever the selection changes, and again on ⟳.
  useEffect(() => {
    if (missing || !viewKey) return
    let alive = true
    fetchView(() => alive).catch((err) => {
      if (alive) onError(err)
    })
    return () => {
      alive = false
    }
  }, [missing, viewKey, fetchView, onError, reload])

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
      PANEL_POLL_MS,
    )
    return () => {
      alive = false
      stop()
    }
  }, [missing, fetchChanges, fetchFiles, fetchView])

  const badges = useMemo(
    () => new Map<string, ChangeStatus>((changes?.files ?? []).map((f) => [f.path, f.status])),
    [changes],
  )
  const matches = useMemo(() => (files ? filterPaths(files, filter) : []), [files, filter])
  const tree = useMemo(() => buildTree(matches.slice(0, MAX_TREE_MATCHES)), [matches])
  const selectedAncestors = useMemo(() => new Set(ancestorDirs(state.selected)), [state.selected])
  const filtering = filter.trim() !== ''
  const isOpen = (dir: string): boolean => filtering || (toggled.get(dir) ?? selectedAncestors.has(dir))
  const toggleDir = (dir: string): void =>
    setToggled((prev) => new Map(prev).set(dir, !(prev.get(dir) ?? selectedAncestors.has(dir))))

  const select = (nextTab: PanelTab, path: string): void =>
    onState({ ...state, tab: nextTab, selected: path, history: [] })
  // Stable identities for the viewer: a re-render here must not make MarkdownView remount its content.
  const openLink = useLatestCallback((path: string): void =>
    onState({
      ...state,
      tab: 'files',
      selected: path,
      history: state.selected ? [...state.history, state.selected] : state.history,
    }),
  )
  const back = useLatestCallback((): void => {
    const history = state.history.slice(0, -1)
    onState({ ...state, tab: 'files', selected: state.history.at(-1), history })
  })
  const setMdMode = useLatestCallback((mdMode: PanelState['mdMode']): void => onState({ ...state, mdMode }))
  const openFile = useLatestCallback((path: string): void => select('files', path))

  const loaded = view && view.key === viewKey ? view.value : undefined
  const change = tab === 'changes' ? changes?.files.find((f) => f.path === shownPath) : undefined

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="Side panel">
          <button role="tab" aria-selected={tab === 'files'} onClick={() => onState({ ...state, tab: 'files' })}>
            Files
          </button>
          {isRepo && (
            <button role="tab" aria-selected={tab === 'changes'} onClick={() => onState({ ...state, tab: 'changes' })}>
              Changes {changes && <span className="panel-count">{changes.files.length}</span>}
            </button>
          )}
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
      {missing ? (
        <div className="panel-missing" role="status">
          ⚠ This task&apos;s folder is missing.
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
                  }}
                />
                <div className="panel-list-scroll">
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
                  {matches.length > MAX_TREE_MATCHES && (
                    <p className="panel-hint">
                      Showing the first {MAX_TREE_MATCHES} of {matches.length} files. Type to narrow it down.
                    </p>
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
            mdMode={state.mdMode}
            canGoBack={state.history.length > 0}
            onBack={back}
            onMdMode={setMdMode}
            onOpenLink={openLink}
            onOpenFile={openFile}
            onError={onError}
          />
        </div>
      )}
    </div>
  )
}
