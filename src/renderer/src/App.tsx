import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, LiveStatus, MeManagerApi, PrereqResult, TabInfo, Target, UnsavedWork } from '../../shared/types'
import { hasUnsavedWork } from '../../shared/types'
import { targetKey } from '../../shared/naming'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { Splitter } from './components/Splitter'
import { NameDialog, RemoveTaskDialog } from './components/Dialogs'
import { Toasts } from './components/Toasts'
import { PrereqScreen } from './components/PrereqScreen'
import { startVisibleInterval } from './lib/visibleInterval'
import { keepIfEqual } from './lib/keepIfEqual'
import { describeTarget } from './lib/describe'
import { useToasts } from './lib/toasts'
import { DEFAULT_PANEL, loadPanelFraction, savePanelFraction, type PanelEntry } from './lib/panelState'
import { isPanelShortcut } from './lib/shortcuts'

// The panel pulls in Markdown, Mermaid, highlight.js and the diff view; load it on first open.
const SidePanel = lazy(() => import('./components/files/SidePanel').then((m) => ({ default: m.SidePanel })))

type Dialog =
  | { kind: 'name'; title: string; placeholder: string; onSubmit: (name: string) => Promise<void> }
  | { kind: 'removeTask'; taskName: string; work: UnsavedWork; onConfirm: (deleteBranch: boolean) => Promise<void> }

const EMPTY: AppState = { version: 1, themes: [] }
const POLL_MS = 3000

const sameTarget = (a: Target | null, b: Target): boolean => a !== null && targetKey(a) === targetKey(b)

export function App({ api }: { api: MeManagerApi }): React.JSX.Element {
  const [prereqs, setPrereqs] = useState<PrereqResult | null>(null)
  const [state, setState] = useState<AppState>(EMPTY)
  const [status, setStatus] = useState<LiveStatus>({ running: [], missing: [] })
  const [selected, setSelected] = useState<Target | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [sessionEnded, setSessionEnded] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const { toasts, showError, dismiss } = useToasts()
  // Mirrors `selected` synchronously, so async responses can check whether their target is still selected.
  const selectedRef = useRef<Target | null>(null)
  // Side panel state per target (by targetKey); `panel` mirrors the selected target's entry.
  const panelsRef = useRef(new Map<string, PanelEntry>())
  const [panel, setPanel] = useState<PanelEntry>(DEFAULT_PANEL)
  const [panelFraction, setPanelFraction] = useState(loadPanelFraction)
  const select = (target: Target | null): void => {
    selectedRef.current = target
    setSelected(target)
    setPanel((target && panelsRef.current.get(targetKey(target))) || DEFAULT_PANEL)
  }

  const updatePanel = useCallback((patch: Partial<PanelEntry>) => {
    const target = selectedRef.current
    if (!target) return
    const key = targetKey(target)
    const next = { ...(panelsRef.current.get(key) ?? DEFAULT_PANEL), ...patch }
    panelsRef.current.set(key, next)
    setPanel(next)
  }, [])

  const togglePanel = useCallback(() => {
    const target = selectedRef.current
    if (target) updatePanel({ open: !panelsRef.current.get(targetKey(target))?.open })
  }, [updatePanel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPanelShortcut(e)) return
      e.preventDefault()
      togglePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel])

  const attempt = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        showError(err)
        return undefined
      }
    },
    [showError],
  )

  const refresh = useCallback(() => {
    // Polled every few seconds: only update (and re-render) when something actually changed.
    api.getStatus().then(
      (next) => setStatus(keepIfEqual(next)),
      () => {},
    )
    const current = selectedRef.current
    if (current)
      api.listTabs(current).then(
        (next) => {
          if (sameTarget(selectedRef.current, current)) setTabs(keepIfEqual(next))
        },
        () => {},
      )
  }, [api])

  const checkPrereqs = useCallback(() => {
    void attempt(async () => setPrereqs(await api.checkPrereqs()))
  }, [api, attempt])

  useEffect(() => {
    checkPrereqs()
    void attempt(async () => setState(await api.getState()))
  }, [api, attempt, checkPrereqs])

  useEffect(() => {
    refresh()
    return startVisibleInterval(refresh, POLL_MS)
  }, [refresh])

  useEffect(
    () =>
      api.onPtyExit(() => {
        setSessionEnded(true)
        setTabs([])
        refresh()
      }),
    [api, refresh],
  )

  const open = async (target: Target): Promise<void> => {
    select(target)
    setSessionEnded(false)
    setTabs([])
    const result = await attempt(() => api.openTarget(target))
    if (!sameTarget(selectedRef.current, target)) return
    setTabs(result ?? [])
    refresh()
  }

  const tabAction = async (fn: (target: Target) => Promise<TabInfo[]>): Promise<void> => {
    const target = selectedRef.current
    if (!target) return
    const result = await attempt(() => fn(target))
    if (result && sameTarget(selectedRef.current, target)) setTabs(result)
  }

  // Reads the ref, not `selected`: callers run after an await, when the selection may have changed.
  const clearSelectionIf = (pred: (t: Target) => boolean): void => {
    const current = selectedRef.current
    if (current && pred(current)) {
      select(null)
      setTabs([])
    }
  }

  const askName = (
    title: string,
    placeholder: string,
    submit: (name: string) => Promise<AppState>,
    after?: (s: AppState, name: string) => void,
  ): void =>
    setDialog({
      kind: 'name',
      title,
      placeholder,
      onSubmit: async (name) => {
        const next = await attempt(() => submit(name))
        if (!next) return
        setState(next)
        setDialog(null)
        after?.(next, name)
      },
    })

  const update = async (fn: () => Promise<AppState>): Promise<AppState | undefined> => {
    const next = await attempt(fn)
    if (next) setState(next)
    return next
  }

  const addPath = async (themeId: string, add: (themeId: string, path: string) => Promise<AppState>): Promise<void> => {
    const path = await attempt(() => api.pickDirectory())
    if (path) await update(() => add(themeId, path))
  }

  const removeTask = async (themeId: string, repoId: string, taskId: string, taskName: string): Promise<void> => {
    const work = await attempt(() => api.checkTaskRemoval(themeId, repoId, taskId))
    if (!work) return
    const doRemove = async (deleteBranch: boolean): Promise<void> => {
      const next = await update(() => api.removeTask(themeId, repoId, taskId, deleteBranch))
      if (!next) return
      setDialog(null)
      clearSelectionIf((t) => t.taskId === taskId)
      refresh()
    }
    if (hasUnsavedWork(work)) setDialog({ kind: 'removeTask', taskName, work, onConfirm: doRemove })
    else await doRemove(true)
  }

  if (prereqs && !prereqs.ok) return <PrereqScreen result={prereqs} onRetry={checkPrereqs} />

  const header = selected ? describeTarget(state, selected) : null
  const item = selected
    ? state.themes.find((t) => t.id === selected.themeId)?.items.find((i) => i.id === selected.itemId)
    : undefined
  const isRepo = item?.kind === 'repo' && selected?.taskId !== undefined

  return (
    <div className="app">
      <Sidebar
        state={state}
        status={status}
        selected={selected}
        onSelect={(t) => void open(t)}
        onAddTheme={() => askName('New theme', 'e.g. Client X', (name) => api.createTheme(name))}
        onRemoveTheme={async (themeId) => {
          if (await update(() => api.removeTheme(themeId))) clearSelectionIf((t) => t.themeId === themeId)
        }}
        onAddRepo={(themeId) => void addPath(themeId, api.addRepo)}
        onAddFolder={(themeId) => void addPath(themeId, api.addFolder)}
        onRemoveItem={async (themeId, itemId) => {
          if (await update(() => api.removeItem(themeId, itemId))) clearSelectionIf((t) => t.itemId === itemId)
        }}
        onAddTask={(themeId, repoId) =>
          askName(
            'New task',
            'e.g. fix login bug',
            (name) => api.createTask(themeId, repoId, name),
            (next, name) => {
              const repo = next.themes.find((t) => t.id === themeId)?.items.find((i) => i.id === repoId)
              const task = repo?.kind === 'repo' ? repo.tasks.find((t) => t.name === name) : undefined
              if (task) void open({ themeId, itemId: repoId, taskId: task.id })
            },
          )
        }
        onRemoveTask={(themeId, repoId, taskId, taskName) => void removeTask(themeId, repoId, taskId, taskName)}
      />
      <main className="main">
        {selected && header ? (
          <>
            <header className="task-header">
              <div className="task-title">{header.title}</div>
              <div className="task-subtitle">{header.subtitle}</div>
            </header>
            <TabBar
              tabs={tabs}
              onSelect={(index) => void tabAction((t) => api.selectTab(t, index))}
              onClose={(index) => void tabAction((t) => api.closeTab(t, index))}
              onNew={() => void tabAction((t) => api.newTab(t))}
              onRestartClaude={() => void tabAction((t) => api.restartClaude(t))}
              panelOpen={panel.open}
              onTogglePanel={togglePanel}
            />
            <div className="workspace">
              <div className="terminal-area">
                <TerminalView api={api} sessionKey={targetKey(selected)} />
                {sessionEnded && (
                  <div className="session-ended">
                    <p>Session ended.</p>
                    <button onClick={() => void open(selected)}>Start again</button>
                  </div>
                )}
              </div>
              {panel.open && (
                <>
                  <Splitter fraction={panelFraction} onChange={setPanelFraction} onCommit={savePanelFraction} />
                  <aside
                    className="side-panel"
                    aria-label="Files panel"
                    style={{ '--panel-width': `${(panelFraction * 100).toFixed(2)}%` } as React.CSSProperties}
                  >
                    <Suspense fallback={<div className="panel-loading">Loading…</div>}>
                      <SidePanel
                        key={targetKey(selected)}
                        api={api}
                        target={selected}
                        isRepo={isRepo}
                        missing={status.missing.includes(targetKey(selected))}
                        state={panel}
                        onState={updatePanel}
                        onError={showError}
                        onClose={() => updatePanel({ open: false })}
                      />
                    </Suspense>
                  </aside>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="empty">Select a task or folder, or create one from the sidebar.</div>
        )}
      </main>
      {dialog?.kind === 'name' && (
        <NameDialog
          title={dialog.title}
          placeholder={dialog.placeholder}
          onSubmit={dialog.onSubmit}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'removeTask' && (
        <RemoveTaskDialog
          taskName={dialog.taskName}
          work={dialog.work}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
