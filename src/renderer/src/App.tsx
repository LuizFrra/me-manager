import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppState,
  LiveStatus,
  MeManagerApi,
  PrereqResult,
  Settings,
  TabInfo,
  Target,
  TaskGitStatus,
  UnsavedWork,
  UsageSummary,
} from '../../shared/types'
import { hasUnsavedWork } from '../../shared/types'
import { targetKey } from '../../shared/naming'
import { clamp, DEFAULT_SETTINGS, FONT_SIZE_LIMITS } from '../../shared/settings'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { Splitter } from './components/Splitter'
import { NameDialog, NotesDialog, RemoveTaskDialog } from './components/Dialogs'
import { TaskHeader } from './components/TaskHeader'
import { Toasts } from './components/Toasts'
import { PrereqScreen } from './components/PrereqScreen'
import { startVisibleInterval } from './lib/visibleInterval'
import { keepIfEqual } from './lib/keepIfEqual'
import { describeTarget, resolveTarget } from './lib/describe'
import { copyEntries, type CopyEntry, type CopyKind } from './lib/copy'
import { useToasts } from './lib/toasts'
import { DEFAULT_PANEL, loadPanelFraction, savePanelFraction, type PanelEntry } from './lib/panelState'
import { isEditableTarget, matchShortcut, shortcutLabel, worksWhileTyping } from './lib/shortcuts'
import { allTargets, visibleTargets } from './lib/targets'
import { filterSidebar } from './lib/sidebarFilter'
import { useLatestCallback } from './lib/useLatestCallback'
import { sessionState } from './lib/sessionState'
import { CommandPalette, type PaletteCommand, type PaletteFiles } from './components/CommandPalette'
import { ShortcutHelp } from './components/ShortcutHelp'
import { SettingsDialog } from './components/SettingsDialog'
import { UsageView } from './components/UsageView'

// The panel pulls in Markdown, Mermaid, highlight.js and the diff view; load it on first open.
const SidePanel = lazy(() => import('./components/files/SidePanel').then((m) => ({ default: m.SidePanel })))

/** What the name dialog asks: a new name, or (with `initial`) a new display name for a theme or task. */
interface NameAsk {
  title: string
  placeholder: string
  initial?: string
  submitLabel?: string
  note?: string
}

type Dialog =
  | ({ kind: 'name'; onSubmit: (name: string) => Promise<void> } & NameAsk)
  | { kind: 'removeTask'; taskName: string; work: UnsavedWork; onConfirm: (deleteBranch: boolean) => Promise<void> }
  | { kind: 'notes'; taskName: string; notes: string; onSave: (notes: string) => Promise<void> }
  | { kind: 'settings' }

type AppAction =
  | { type: 'open'; target: Target }
  | {
      type:
        | 'newTheme'
        | 'togglePanel'
        | 'newTab'
        | 'restartClaude'
        | 'renameTask'
        | 'openEditor'
        | 'fileManager'
        | 'settings'
        | 'help'
        | 'usage'
    }
  | { type: 'copy'; kind: CopyKind }

/** Palette entries carry data only; runCommand acts on them when one is picked. */
interface AppCommand extends PaletteCommand {
  action: AppAction
}

/** Renaming changes the display name only, never the slug that branches, worktrees and sessions are named by. */
const RENAME_NOTE = 'The branch and folder keep their original name.'

const EMPTY: AppState = { version: 1, themes: [] }
/** Terminal zoom saves the font size once the keys have been still this long. */
export const ZOOM_SAVE_MS = 500
/** The header's usage badge refreshes this often: reading transcripts costs more than the status poll. */
export const USAGE_POLL_MS = 10_000

const sameTarget = (a: Target | null, b: Target): boolean => a !== null && targetKey(a) === targetKey(b)

export function App({ api }: { api: MeManagerApi }): React.JSX.Element {
  const [prereqs, setPrereqs] = useState<PrereqResult | null>(null)
  const [state, setState] = useState<AppState>(EMPTY)
  const [status, setStatus] = useState<LiveStatus>({ running: [], missing: [], activity: {} })
  // Git status of the visible tasks (and the selected one), by task id.
  const [gitStatus, setGitStatus] = useState<Record<string, TaskGitStatus>>({})
  const [selected, setSelected] = useState<Target | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [sessionEnded, setSessionEnded] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  // The selected target's usage, tagged with its targetKey so another target's numbers never show.
  const [usage, setUsage] = useState<{ key: string; summary: UsageSummary } | null>(null)
  // The defaults until main answers; the poll interval and terminal font size follow it.
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [sidebarFilter, setSidebarFilter] = useState('')
  const sidebarFilterRef = useRef<HTMLInputElement>(null)
  const toggleCollapsed = useCallback(
    (id: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )
  const { toasts, showError, showInfo, dismiss } = useToasts()
  // The tmux socket name, for "copy attach command"; null until main has told us.
  const [tmuxSocket, setTmuxSocket] = useState<string | null>(null)
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

  // The tasks whose git status is polled: the ones the sidebar shows, plus the selected one for the header.
  const gitTargets = useMemo(() => {
    const targets = visibleTargets(state, collapsed, filterSidebar(state, sidebarFilter)).filter((t) => t.taskId)
    if (selected?.taskId && !targets.some((t) => sameTarget(selected, t))) targets.push(selected)
    return targets
  }, [state, collapsed, sidebarFilter, selected])
  const gitTargetsRef = useRef<Target[]>([])
  // Responses can arrive out of order; only a newer request's answer replaces what is shown.
  const gitSeq = useRef({ sent: 0, shown: 0 })
  const refreshGit = useCallback(() => {
    const targets = gitTargetsRef.current
    const seq = ++gitSeq.current.sent
    const show = (next: Record<string, TaskGitStatus>): void => {
      if (seq < gitSeq.current.shown) return
      gitSeq.current.shown = seq
      setGitStatus(keepIfEqual(next))
    }
    if (targets.length === 0) return show({})
    // Main reads each worktree at most every few seconds, so this is cheap at any poll interval.
    api.getGitStatus(targets).then(show, () => {}) // the badges keep their last values
  }, [api])
  useEffect(() => {
    gitTargetsRef.current = gitTargets
    refreshGit()
  }, [gitTargets, refreshGit])

  const refresh = useCallback(() => {
    // Polled every few seconds: only update (and re-render) when something actually changed.
    api.getStatus().then(
      (next) => setStatus(keepIfEqual(next)),
      () => {},
    )
    refreshGit()
    const current = selectedRef.current
    if (current)
      api.listTabs(current).then(
        (next) => {
          if (sameTarget(selectedRef.current, current)) setTabs(keepIfEqual(next))
        },
        () => {},
      )
  }, [api, refreshGit])

  const refreshUsage = useCallback((): Promise<void> | undefined => {
    const current = selectedRef.current
    if (!current) return undefined
    const key = targetKey(current)
    return api.getUsage(current).then(
      (summary) => {
        if (!sameTarget(selectedRef.current, current)) return
        const next = { key, summary }
        setUsage((prev) => (prev ? keepIfEqual(next)(prev) : next))
      },
      () => {}, // the badge just keeps its last numbers
    )
  }, [api])

  const checkPrereqs = useCallback(() => {
    void attempt(async () => setPrereqs(await api.checkPrereqs()))
  }, [api, attempt])

  useEffect(() => {
    checkPrereqs()
    void attempt(async () => setState(await api.getState()))
    api.getTmuxSocket().then(setTmuxSocket, () => {}) // without it, only the attach command is missing
    void attempt(async () => setSettings(await api.getSettings()))
  }, [api, attempt, checkPrereqs])

  const pollMs = settings.pollIntervalMs
  useEffect(() => {
    refresh()
    return startVisibleInterval(refresh, pollMs)
  }, [refresh, pollMs])

  const selectedKey = selected ? targetKey(selected) : null
  useEffect(() => {
    if (selectedKey === null) return undefined
    void refreshUsage()
    return startVisibleInterval(refreshUsage, USAGE_POLL_MS)
  }, [refreshUsage, selectedKey])

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

  // A desktop notification was clicked: show its target, expanding its theme and repo if they are collapsed.
  const onSelectTarget = useLatestCallback((target: Target): void => {
    setCollapsed((prev) => {
      if (!prev.has(target.themeId) && !prev.has(target.itemId)) return prev
      const next = new Set(prev)
      next.delete(target.themeId)
      next.delete(target.itemId)
      return next
    })
    if (!sameTarget(selectedRef.current, target)) void open(target)
  })
  useEffect(() => api.onSelectTarget(onSelectTarget), [api, onSelectTarget])

  const tabAction = async (fn: (target: Target) => Promise<TabInfo[]>): Promise<void> => {
    const target = selectedRef.current
    if (!target) return
    const result = await attempt(() => fn(target))
    if (result && sameTarget(selectedRef.current, target)) setTabs(result)
  }

  const cycleTab = (step: number): void => {
    const current = tabs.findIndex((t) => t.active)
    if (current === -1 || tabs.length < 2) return
    const next = tabs[(current + step + tabs.length) % tabs.length]
    void tabAction((t) => api.selectTab(t, next.index))
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
    ask: NameAsk,
    submit: (name: string) => Promise<AppState>,
    after?: (s: AppState, name: string) => void,
  ): void =>
    setDialog({
      kind: 'name',
      ...ask,
      onSubmit: async (name) => {
        const next = await attempt(() => submit(name))
        if (!next) return
        setState(next)
        setDialog(null)
        after?.(next, name)
      },
    })

  const newTheme = (): void =>
    askName({ title: 'New theme', placeholder: 'e.g. Client X' }, (name) => api.createTheme(name))

  const askRename = (what: 'theme' | 'task', current: string, submit: (name: string) => Promise<AppState>): void =>
    askName(
      { title: `Rename ${what}`, placeholder: current, initial: current, submitLabel: 'Rename', note: RENAME_NOTE },
      submit,
    )
  const renameTheme = (themeId: string, current: string): void =>
    askRename('theme', current, (name) => api.renameTheme(themeId, name))
  const renameTask = (themeId: string, repoId: string, taskId: string, current: string): void =>
    askRename('task', current, (name) => api.renameTask(themeId, repoId, taskId, name))

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

  const openSettings = (): void => setDialog({ kind: 'settings' })

  // Terminal zoom applies at once and is saved debounced; a size still waiting is saved if the App unmounts.
  const zoomSave = useRef<{ timer: ReturnType<typeof setTimeout>; size: number } | null>(null)
  useEffect(
    () => () => {
      const pending = zoomSave.current
      if (!pending) return
      clearTimeout(pending.timer)
      api.updateSettings({ terminalFontSize: pending.size }).catch(() => {})
    },
    [api],
  )
  const zoom = (step: 1 | -1 | 0): void => {
    const current = settings.terminalFontSize
    const size = step === 0 ? DEFAULT_SETTINGS.terminalFontSize : clamp(current + step, FONT_SIZE_LIMITS)
    showInfo(`Font size ${size}`)
    if (size === current) return
    setSettings((s) => ({ ...s, terminalFontSize: size }))
    if (zoomSave.current) clearTimeout(zoomSave.current.timer)
    const timer = setTimeout(() => {
      zoomSave.current = null
      void attempt(() => api.updateSettings({ terminalFontSize: size }))
    }, ZOOM_SAVE_MS)
    zoomSave.current = { timer, size }
  }

  /** Opens the selected task's worktree or folder in an editor, or in the file manager. */
  const openExternally = (where: 'editor' | 'fileManager'): void => {
    const target = selectedRef.current
    if (!target) return
    void attempt(async () => {
      if (where === 'editor') await api.openInEditor(target)
      else await api.openInFileManager(target)
      showInfo(where === 'editor' ? 'Opening in the editor…' : 'Opening the file manager…')
    })
  }

  // App shortcuts arrive here from anywhere in the window; TerminalView's key handler lets them through
  // instead of sending them to tmux. Which ones act when:
  // - a name or remove dialog is open: none (it is a modal flow of its own);
  // - the palette, help or usage overlay is open: only their toggles (Mod+Shift+P, Mod+Shift+/, Mod+Shift+U), which
  //   also switch between them;
  // - a text field has focus: only the palette, help and panel toggles (see worksWhileTyping), so inputs keep
  //   their keys. The terminal's hidden textarea doesn't count as a text field.
  const onShortcutKey = useLatestCallback((e: KeyboardEvent): void => {
    const shortcut = matchShortcut(e)
    if (!shortcut || dialog) return
    if (shortcut.id === 'palette' || shortcut.id === 'help' || shortcut.id === 'usage') {
      e.preventDefault()
      setPaletteOpen((o) => shortcut.id === 'palette' && !o)
      setHelpOpen((o) => shortcut.id === 'help' && !o)
      setUsageOpen((o) => shortcut.id === 'usage' && !o)
      return
    }
    if (paletteOpen || helpOpen || usageOpen) return
    if (!worksWhileTyping(shortcut.id) && isEditableTarget(e.target)) return
    e.preventDefault()
    switch (shortcut.id) {
      case 'settings':
        return openSettings()
      case 'openEditor':
        return openExternally('editor')
      case 'zoomIn':
      case 'zoomOut':
      case 'zoomReset':
        return zoom(shortcut.id === 'zoomIn' ? 1 : shortcut.id === 'zoomOut' ? -1 : 0)
      case 'panel':
        return togglePanel()
      case 'filterSidebar':
        sidebarFilterRef.current?.focus()
        sidebarFilterRef.current?.select()
        return
      case 'target': {
        const target = visibleTargets(state, collapsed, filterSidebar(state, sidebarFilter))[shortcut.index]
        if (target && !sameTarget(selectedRef.current, target)) void open(target)
        return
      }
      case 'newTab':
        return void tabAction((t) => api.newTab(t))
      case 'closeTab': {
        const active = tabs.find((t) => t.active)
        if (active) void tabAction((t) => api.closeTab(t, active.index))
        return
      }
      case 'prevTab':
      case 'nextTab':
        return cycleTab(shortcut.id === 'nextTab' ? 1 : -1)
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', onShortcutKey)
    return () => window.removeEventListener('keydown', onShortcutKey)
  }, [onShortcutKey])

  const openFileInPanel = useCallback(
    (path: string) => updatePanel({ open: true, tab: 'files', selected: path, history: [] }),
    [updatePanel],
  )
  // Stable while the selection is, so the palette lists the files once per opening.
  const loadPaletteFiles = useMemo(
    () => (selected ? (): Promise<PaletteFiles> => api.listFiles(selected) : undefined),
    [api, selected],
  )

  const paletteCommands = (): AppCommand[] => {
    const commands: AppCommand[] = allTargets(state).map((entry) => ({
      id: `target:${targetKey(entry.target)}`,
      kind: entry.kind,
      label: entry.label,
      action: { type: 'open', target: entry.target },
    }))
    const action = (label: string, type: Exclude<AppAction['type'], 'open' | 'copy'>, shortcut?: string): void => {
      commands.push({ id: `action:${type}`, kind: 'action', label, shortcut, action: { type } })
    }
    action('New theme', 'newTheme')
    if (selected) {
      action('Toggle files panel', 'togglePanel', shortcutLabel('panel'))
      action('New shell tab', 'newTab', shortcutLabel('newTab'))
      action('Restart Claude', 'restartClaude')
      action('Open in editor', 'openEditor', shortcutLabel('openEditor'))
      action('Reveal in file manager', 'fileManager')
    }
    if (selected?.taskId) action('Rename current task', 'renameTask')
    for (const { kind, label } of copiesFor(selected))
      commands.push({ id: `action:copy:${kind}`, kind: 'action', label, action: { type: 'copy', kind } })
    action('Show usage', 'usage', shortcutLabel('usage'))
    action('Open settings', 'settings', shortcutLabel('settings'))
    action('Show keyboard shortcuts', 'help', shortcutLabel('help'))
    return commands
  }

  const saveSettings = async (next: Settings): Promise<void> => {
    const saved = await attempt(() => api.updateSettings(next))
    if (!saved) return
    setSettings(saved)
    setDialog(null)
    showInfo('Settings saved')
  }

  const editNotes = (target: Target): void => {
    const task = resolveTarget(state, target)?.task
    if (!task || !target.taskId) return
    const { themeId, itemId, taskId } = target
    setDialog({
      kind: 'notes',
      taskName: task.name,
      notes: task.notes ?? '',
      onSave: async (notes) => {
        if (await update(() => api.setTaskNotes(themeId, itemId, taskId, notes))) setDialog(null)
      },
    })
  }

  const copiesFor = (target: Target | null): CopyEntry[] => {
    const found = target && resolveTarget(state, target)
    return found ? copyEntries(found, tmuxSocket) : []
  }

  const copy = async (entry: CopyEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.text)
      showInfo(`Copied ${entry.what}`)
    } catch {
      showError(`Could not copy the ${entry.what} to the clipboard`)
    }
  }

  const renameSelectedTask = (): void => {
    const target = selectedRef.current
    const task = target ? resolveTarget(state, target)?.task : undefined
    if (target?.taskId && task) renameTask(target.themeId, target.itemId, target.taskId, task.name)
  }

  const runCommand = ({ action }: AppCommand): void => {
    if (action.type === 'open') void open(action.target)
    else if (action.type === 'newTheme') newTheme()
    else if (action.type === 'togglePanel') togglePanel()
    else if (action.type === 'newTab') void tabAction((t) => api.newTab(t))
    else if (action.type === 'restartClaude') void tabAction((t) => api.restartClaude(t))
    else if (action.type === 'renameTask') renameSelectedTask()
    else if (action.type === 'settings') openSettings()
    else if (action.type === 'usage') setUsageOpen(true)
    else if (action.type === 'openEditor') openExternally('editor')
    else if (action.type === 'fileManager') openExternally('fileManager')
    else if (action.type === 'copy') {
      const entry = copiesFor(selectedRef.current).find((e) => e.kind === action.kind)
      if (entry) void copy(entry)
    } else setHelpOpen(true)
  }

  if (prereqs && !prereqs.ok) return <PrereqScreen result={prereqs} onRetry={checkPrereqs} />

  const header = selected ? describeTarget(state, selected) : null
  const selectedTask = selected ? resolveTarget(state, selected)?.task : undefined
  const item = selected
    ? state.themes.find((t) => t.id === selected.themeId)?.items.find((i) => i.id === selected.itemId)
    : undefined
  const isRepo = item?.kind === 'repo' && selected?.taskId !== undefined

  return (
    <div className="app">
      <Sidebar
        state={state}
        status={status}
        gitStatus={gitStatus}
        selected={selected}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        filter={sidebarFilter}
        onFilterChange={setSidebarFilter}
        filterRef={sidebarFilterRef}
        onSelect={(t) => void open(t)}
        onAddTheme={newTheme}
        onRenameTheme={renameTheme}
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
            { title: 'New task', placeholder: 'e.g. fix login bug' },
            (name) => api.createTask(themeId, repoId, name),
            (next, name) => {
              const repo = next.themes.find((t) => t.id === themeId)?.items.find((i) => i.id === repoId)
              const task = repo?.kind === 'repo' ? repo.tasks.find((t) => t.name === name) : undefined
              if (task) void open({ themeId, itemId: repoId, taskId: task.id })
            },
          )
        }
        onRenameTask={renameTask}
        onRemoveTask={(themeId, repoId, taskId, taskName) => void removeTask(themeId, repoId, taskId, taskName)}
        onOpenSettings={openSettings}
        onOpenUsage={() => setUsageOpen(true)}
      />
      <main className="main">
        {selected && header ? (
          <>
            <TaskHeader
              key={targetKey(selected)}
              title={header.title}
              subtitle={header.subtitle}
              notes={selectedTask?.notes}
              onEditNotes={selectedTask ? () => editNotes(selected) : undefined}
              copies={copiesFor(selected)}
              onCopy={(entry) => void copy(entry)}
              onOpenInEditor={() => openExternally('editor')}
              onRevealInFileManager={() => openExternally('fileManager')}
              sessionFlags={settings}
              usage={usage?.key === targetKey(selected) ? usage.summary : undefined}
              onOpenUsage={() => setUsageOpen(true)}
              git={selectedTask ? gitStatus[selectedTask.id] : undefined}
              baseRef={selectedTask?.baseRef}
              session={sessionState(status, targetKey(selected))}
            />
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
                <TerminalView api={api} sessionKey={targetKey(selected)} fontSize={settings.terminalFontSize} />
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
                        pollMs={pollMs}
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
          initial={dialog.initial}
          submitLabel={dialog.submitLabel}
          note={dialog.note}
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
      {dialog?.kind === 'notes' && (
        <NotesDialog
          taskName={dialog.taskName}
          initial={dialog.notes}
          onSave={dialog.onSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog settings={settings} onSave={saveSettings} onCancel={() => setDialog(null)} />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands()}
          onRun={runCommand}
          loadFiles={loadPaletteFiles}
          onOpenFile={openFileInPanel}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {usageOpen && (
        <UsageView
          api={api}
          onClose={() => setUsageOpen(false)}
          onOpenTarget={(target) => {
            if (!sameTarget(selectedRef.current, target)) void open(target)
          }}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
