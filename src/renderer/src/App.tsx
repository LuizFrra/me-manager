import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, LiveStatus, MeManagerApi, PrereqResult, TabInfo, Target, UnsavedWork } from '../../shared/types'
import { hasUnsavedWork } from '../../shared/types'
import { targetKey } from '../../shared/naming'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { NameDialog, RemoveTaskDialog } from './components/Dialogs'
import { Toasts, useToasts } from './components/Toasts'
import { PrereqScreen } from './components/PrereqScreen'
import { describeTarget } from './lib/describe'

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
  const select = (target: Target | null): void => {
    selectedRef.current = target
    setSelected(target)
  }

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
    api.getStatus().then(setStatus, () => {})
    const current = selectedRef.current
    if (current)
      api.listTabs(current).then(
        (next) => {
          if (sameTarget(selectedRef.current, current)) setTabs(next)
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
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
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

  const askName = (title: string, placeholder: string, submit: (name: string) => Promise<AppState>, after?: (s: AppState, name: string) => void): void =>
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
            />
            <div className="terminal-area">
              <TerminalView api={api} sessionKey={targetKey(selected)} />
              {sessionEnded && (
                <div className="session-ended">
                  <p>Session ended.</p>
                  <button onClick={() => void open(selected)}>Start again</button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty">Select a task or folder, or create one from the sidebar.</div>
        )}
      </main>
      {dialog?.kind === 'name' && (
        <NameDialog title={dialog.title} placeholder={dialog.placeholder} onSubmit={dialog.onSubmit} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'removeTask' && (
        <RemoveTaskDialog taskName={dialog.taskName} work={dialog.work} onConfirm={dialog.onConfirm} onCancel={() => setDialog(null)} />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
