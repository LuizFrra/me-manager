import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppState,
  GitTools,
  LiveStatus,
  MeManagerApi,
  NewTaskOptions,
  PrereqResult,
  Settings,
  TabInfo,
  Target,
  Task,
  TaskGitStatus,
  ThemeStyle,
  UiState,
  UnsavedWork,
  UpdateResult,
  UsageSummary,
} from '../../shared/types'
import { hasUnsavedWork, isArchived, MAX_TRANSCRIPT_BYTES } from '../../shared/types'
import { targetKey } from '../../shared/naming'
import { clamp, DEFAULT_SETTINGS, FONT_SIZE_LIMITS } from '../../shared/settings'
import { GH_INSTALL_HINT } from '../../shared/git'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { Splitter } from './components/Splitter'
import {
  ArchiveTaskDialog,
  ChooseThemeDialog,
  CloneRepoDialog,
  CommitDialog,
  ConfirmRemoveDialog,
  ConflictDialog,
  DeleteArchivedTaskDialog,
  NameDialog,
  NewTaskDialog,
  NotesDialog,
  RemoveTaskDialog,
  ReviewCommentDialog,
  type RemovalKind,
} from './components/Dialogs'
import { TaskHeader } from './components/TaskHeader'
import { Toasts } from './components/Toasts'
import { PrereqScreen } from './components/PrereqScreen'
import { startVisibleInterval } from './lib/visibleInterval'
import { keepIfEqual } from './lib/keepIfEqual'
import { describeTarget, resolveTarget } from './lib/describe'
import { copyEntries, type CopyEntry, type CopyKind } from './lib/copy'
import { useToasts } from './lib/toasts'
import type { GitActionKind } from './lib/gitActions'
import { plural } from './lib/gitStatus'
import { clampFraction, DEFAULT_PANEL, loadPanelFraction, savePanelFraction, type PanelEntry } from './lib/panelState'
import { isEditableTarget, matchShortcut, shortcutLabel, worksWhileTyping } from './lib/shortcuts'
import { allTargets, visibleTargets } from './lib/targets'
import { filterSidebar } from './lib/sidebarFilter'
import { useLatestCallback } from './lib/useLatestCallback'
import { placeBack, placeOf } from './lib/placeBack'
import { effectiveSessionFlags } from './lib/sessionFlags'
import { sessionState } from './lib/sessionState'
import { CommandPalette, type PaletteCommand, type PaletteFiles } from './components/CommandPalette'
import { ShortcutHelp } from './components/ShortcutHelp'
import { SettingsDialog } from './components/SettingsDialog'
import { UsageView } from './components/UsageView'
import { StatusBar } from './components/StatusBar'
import { ThemeStyleDialog } from './components/ThemeStyleDialog'
import { Home, Welcome } from './components/Welcome'
import { ArchivedTaskView } from './components/ArchivedTaskView'
import { formatReview, reviewLocation, type ReviewComment, type ReviewDraft } from './lib/review'

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

type DialogBody =
  | ({ kind: 'name'; onSubmit: (name: string) => Promise<void> } & NameAsk)
  | { kind: 'removeTask'; taskName: string; work: UnsavedWork; onConfirm: (deleteBranch: boolean) => Promise<void> }
  | { kind: 'archiveTask'; taskName: string; work: UnsavedWork; onConfirm: () => Promise<void> }
  | {
      kind: 'deleteArchived'
      taskName: string
      branch: string
      baseRef: string
      work: UnsavedWork
      onConfirm: () => Promise<void>
    }
  | { kind: 'notes'; taskName: string; notes: string; onSave: (notes: string) => Promise<void> }
  /** A review comment's note: a new one (no `initial`) or an edit. */
  | { kind: 'reviewComment'; location: string; initial?: string; onSave: (note: string) => void }
  | { kind: 'newTask'; themeId: string; repoId: string; repoName: string }
  | { kind: 'commit'; target: Target; taskName: string; branch: string }
  | { kind: 'conflicts'; target: Target; branch: string; result: Extract<UpdateResult, { kind: 'conflict' }> }
  | { kind: 'settings' }
  | { kind: 'clone'; themeId: string; themeName: string }
  | { kind: 'themeStyle'; themeId: string; themeName: string; style: ThemeStyle }
  | { kind: 'chooseTheme'; title: string; onChoose: (themeId: string) => void }
  | {
      kind: 'confirmRemove'
      what: RemovalKind
      name: string
      themeName?: string
      path?: string
      contents?: string
      onConfirm: () => Promise<void>
    }

/**
 * A dialog as shown: `id` tells this one apart from a later dialog of the same kind, so an action that finishes in
 * the background closes (or follows up on) only the dialog it was started from, never one opened since.
 */
type Dialog = DialogBody & { id: number }

type AppAction =
  | { type: 'open'; target: Target }
  | {
      type:
        | 'newTheme'
        | 'togglePanel'
        | 'searchFiles'
        | 'newTab'
        | 'restartClaude'
        | 'renameTask'
        | 'openEditor'
        | 'fileManager'
        | 'settings'
        | 'help'
        | 'usage'
        | 'commit'
        | 'push'
        | 'openPr'
        | 'update'
        | 'toggleStatusBar'
        | 'customizeTheme'
        | 'copyTranscript'
        | 'saveTranscript'
        | 'archiveTask'
        | 'restoreTask'
        | 'deleteArchivedTask'
    }
  | { type: 'copy'; kind: CopyKind }

/** Palette entries carry data only; runCommand acts on them when one is picked. */
interface AppCommand extends PaletteCommand {
  action: AppAction
}

/** Renaming changes the display name only, never the slug that branches, worktrees and sessions are named by. */
const RENAME_NOTE = 'The branch and folder keep their original name.'

const EMPTY: AppState = { version: 1, themes: [] }
const NO_COMMENTS: readonly ReviewComment[] = []
/** Terminal zoom saves the font size once the keys have been still this long. */
export const ZOOM_SAVE_MS = 500
/** UI state (selection, collapsed groups, panels, filter) is saved once it has been still this long. */
export const UI_SAVE_MS = 500
/** The header's usage badge refreshes this often: reading transcripts costs more than the status poll. */
export const USAGE_POLL_MS = 10_000

/** For a transcript's confirmation: a note when it holds only the end of the scrollback. */
const transcriptCut = ({ truncated }: { truncated: boolean }): string =>
  truncated ? ` (the last ${MAX_TRANSCRIPT_BYTES / (1024 * 1024)} MB of the scrollback)` : ''

const sameTarget = (a: Target | null, b: Target): boolean => a !== null && targetKey(a) === targetKey(b)

/** Whether `target` is an archived task: it has no session or worktree, so nothing may open, attach or poll it. */
const isArchivedTarget = (state: AppState, target: Target | null): boolean => {
  const task = target ? resolveTarget(state, target)?.task : undefined
  return task !== undefined && isArchived(task)
}

/** What "copy …" offers for `target`: its branch, path, attach command. */
function copiesOf(state: AppState, target: Target | null, tmuxSocket: string | null): CopyEntry[] {
  const found = target && resolveTarget(state, target)
  return found ? copyEntries(found, tmuxSocket) : []
}

/** The palette's entries: every task and folder, then the actions that apply to the selection (and its tab). */
function buildPaletteCommands(
  state: AppState,
  selected: Target | null,
  hasActiveTab: boolean,
  ghAvailable: boolean,
  tmuxSocket: string | null,
): AppCommand[] {
  const commands: AppCommand[] = allTargets(state).map((entry) => ({
    id: `target:${targetKey(entry.target)}`,
    kind: entry.kind,
    label: entry.label,
    icon: entry.icon,
    action: { type: 'open', target: entry.target },
  }))
  const action = (label: string, type: Exclude<AppAction['type'], 'open' | 'copy'>, shortcut?: string): void => {
    commands.push({ id: `action:${type}`, kind: 'action', label, shortcut, action: { type } })
  }
  action('New theme', 'newTheme')
  if (selected && isArchivedTarget(state, selected)) {
    // Nothing else applies: there is no session, worktree or folder to act on until it is restored.
    action('Restore archived task', 'restoreTask')
    action('Delete archived task…', 'deleteArchivedTask')
  } else if (selected) {
    action('Toggle files panel', 'togglePanel', shortcutLabel('panel'))
    action('Search in files', 'searchFiles', shortcutLabel('searchFiles'))
    action('New shell tab', 'newTab', shortcutLabel('newTab'))
    action('Restart Claude', 'restartClaude')
    if (hasActiveTab) {
      action('Copy transcript of current tab', 'copyTranscript')
      action('Save transcript of current tab', 'saveTranscript')
    }
    action('Open in editor', 'openEditor', shortcutLabel('openEditor'))
    action('Reveal in file manager', 'fileManager')
    action('Toggle status bar', 'toggleStatusBar')
    action('Customize theme…', 'customizeTheme')
  }
  if (selected?.taskId && !isArchivedTarget(state, selected)) {
    action('Rename current task', 'renameTask')
    action('Git: Commit all…', 'commit')
    action('Git: Push branch', 'push')
    action(ghAvailable ? 'Git: Open pull request' : 'Git: Open pull request (needs gh)', 'openPr')
    action('Git: Update from base', 'update')
    action('Archive current task', 'archiveTask')
  }
  const copies = isArchivedTarget(state, selected) ? [] : copiesOf(state, selected, tmuxSocket)
  for (const { kind, label } of copies)
    commands.push({ id: `action:copy:${kind}`, kind: 'action', label, action: { type: 'copy', kind } })
  action('Show usage', 'usage', shortcutLabel('usage'))
  action('Open settings', 'settings', shortcutLabel('settings'))
  action('Show keyboard shortcuts', 'help', shortcutLabel('help'))
  return commands
}

export function App({ api }: { api: MeManagerApi }): React.JSX.Element {
  const [prereqs, setPrereqs] = useState<PrereqResult | null>(null)
  const [state, setState] = useState<AppState>(EMPTY)
  // Mirrors `state`, for an "Undo" that runs later and must see the themes as they are by then.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  // Whether the first getState has answered: until then "no themes" may just mean "not loaded yet".
  const [stateLoaded, setStateLoaded] = useState(false)
  const [status, setStatus] = useState<LiveStatus>({ running: [], missing: [], activity: {} })
  // Git status of the visible tasks (and the selected one), by task id.
  const [gitStatus, setGitStatus] = useState<Record<string, TaskGitStatus>>({})
  const [selected, setSelected] = useState<Target | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [sessionEnded, setSessionEnded] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  // Mirrors `dialog` synchronously, for actions that finish after an await.
  const dialogRef = useRef<Dialog | null>(null)
  // Counts every dialog or overlay opened; a dialog's id is the count when it opened. While it equals a dialog's
  // id, nothing else has been opened since that dialog.
  const modalEpoch = useRef(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  // Whether the palette, help or usage overlay is open, for actions that finish after an await.
  const overlayOpen = paletteOpen || helpOpen || usageOpen
  const overlayOpenRef = useRef(false)
  useEffect(() => {
    overlayOpenRef.current = overlayOpen
    if (overlayOpen) modalEpoch.current++
  }, [overlayOpen])
  // The selected target's usage, tagged with its targetKey so another target's numbers never show.
  const [usage, setUsage] = useState<{ key: string; summary: UsageSummary } | null>(null)
  // gh is assumed missing until main says otherwise; the PR button then explains how to install it.
  const [gitTools, setGitTools] = useState<GitTools>({ gh: false })
  // The git action running on each task, by targetKey (one at a time per task, like main's queue).
  const [gitBusy, setGitBusy] = useState<Record<string, GitActionKind>>({})
  const gitBusyRef = useRef<Record<string, GitActionKind>>({})
  // The defaults until main answers; the poll interval and terminal font size follow it.
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  // Repos whose "Archived" group is expanded; each starts collapsed.
  const [archivedOpen, setArchivedOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleArchived = useCallback(
    (repoId: string) =>
      setArchivedOpen((prev) => {
        const next = new Set(prev)
        if (next.has(repoId)) next.delete(repoId)
        else next.add(repoId)
        return next
      }),
    [],
  )
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
  // Review comments by targetKey, in the order they were made; kept for the session only (never saved).
  const [reviews, setReviews] = useState<Record<string, ReviewComment[]>>({})
  const reviewIds = useRef(0)
  // Targets whose comments are being sent to Claude, by targetKey; the ref also blocks a second click that lands
  // before the Send button is disabled.
  const [reviewSending, setReviewSending] = useState<Record<string, true>>({})
  const reviewSendingRef = useRef(new Set<string>())
  // Bumped to focus the terminal: after the comments were pasted into Claude's prompt.
  const [terminalFocus, setTerminalFocus] = useState(0)
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

  /** Shows a dialog in place of the current one; returns its id. */
  const openDialog = (body: DialogBody): number => {
    const id = ++modalEpoch.current
    const next: Dialog = { ...body, id }
    dialogRef.current = next
    setDialog(next)
    return id
  }
  /** Closes dialog `id` if it is still the one shown; true if it was. */
  const closeDialog = (id: number): boolean => {
    if (dialogRef.current?.id !== id) return false
    dialogRef.current = null
    setDialog(null)
    return true
  }

  const updatePanel = useCallback((patch: Partial<PanelEntry>) => {
    const target = selectedRef.current
    if (!target) return
    const key = targetKey(target)
    const next = { ...(panelsRef.current.get(key) ?? DEFAULT_PANEL), ...patch }
    // Re-inserted, so the map runs from least to most recently changed (the saved UI state keeps the newest).
    panelsRef.current.delete(key)
    panelsRef.current.set(key, next)
    setPanel(next)
  }, [])

  const togglePanel = useCallback(() => {
    const target = selectedRef.current
    if (target) updatePanel({ open: !panelsRef.current.get(targetKey(target))?.open })
  }, [updatePanel])

  // "Search in files" opens the panel on its Search tab and focuses the input: the bump says "focus now", the
  // pending flag (taken once) keeps a later remount of the panel, e.g. on switching tasks, from stealing focus.
  const [searchFocus, setSearchFocus] = useState(0)
  const searchFocusPending = useRef(false)
  const takeSearchFocus = useCallback((): boolean => {
    const pending = searchFocusPending.current
    searchFocusPending.current = false
    return pending
  }, [])
  const searchInFiles = useCallback(() => {
    if (!selectedRef.current) return
    searchFocusPending.current = true
    setSearchFocus((n) => n + 1)
    updatePanel({ open: true, tab: 'search' })
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
    if (selected?.taskId && !isArchivedTarget(state, selected) && !targets.some((t) => sameTarget(selected, t)))
      targets.push(selected)
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
    if (current && !isArchivedTarget(stateRef.current, current))
      api.listTabs(current).then(
        (next) => {
          if (sameTarget(selectedRef.current, current)) setTabs(keepIfEqual(next))
        },
        () => {},
      )
  }, [api, refreshGit])

  const refreshUsage = useCallback((): Promise<void> | undefined => {
    const current = selectedRef.current
    if (!current || isArchivedTarget(stateRef.current, current)) return undefined
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
    api.getTmuxSocket().then(setTmuxSocket, () => {}) // without it, only the attach command is missing
    api.getGitTools().then(setGitTools, () => {}) // without it, "PR" says gh is missing
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

  /**
   * `quiet`: a failure selects nothing instead of showing an error (restoring the last selection at start). An
   * archived task is only selected: there is no session to open, and the main area offers Restore instead.
   */
  const open = async (target: Target, { quiet = false, state: known = stateRef.current } = {}): Promise<void> => {
    select(target)
    setSessionEnded(false)
    setTabs([])
    if (isArchivedTarget(known, target)) {
      void api.detachTerminal().catch(() => {}) // the previous task is no longer shown
      return
    }
    const result = quiet
      ? await api.openTarget(target).catch(() => undefined)
      : await attempt(() => api.openTarget(target))
    if (!sameTarget(selectedRef.current, target)) return
    if (result === undefined && quiet) {
      select(null)
      return
    }
    setTabs(result ?? [])
    refresh()
  }

  // The UI as it was left (ui-state.json in main): restored once at start, then saved debounced and on unload.
  // Nothing is saved before the restore has run, so a slow start can't overwrite what was saved with defaults.
  const uiRestored = useRef(false)
  const uiSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uiSnapshot = useLatestCallback((): UiState => ({
    version: 1,
    ...(selectedRef.current ? { selected: selectedRef.current } : {}),
    collapsed: [...collapsed],
    panels: Object.fromEntries(
      [...panelsRef.current].map(([key, e]) => [
        key,
        { open: e.open, tab: e.tab, ...(e.selected ? { selected: e.selected } : {}) },
      ]),
    ),
    panelWidth: panelFraction,
    ...(sidebarFilter.trim() ? { sidebarFilter } : {}),
    ...(archivedOpen.size > 0 ? { archivedOpen: [...archivedOpen] } : {}),
  }))
  const saveUiNow = useLatestCallback((): void => {
    if (uiSaveTimer.current === null) return
    clearTimeout(uiSaveTimer.current)
    uiSaveTimer.current = null
    api.saveUiState(uiSnapshot()).catch(() => {}) // not worth an error: the UI just isn't remembered
  })

  /**
   * Applies the saved UI state: collapsed groups, sidebar filter, panel entries and width, then the selection, which
   * is opened only if it still exists and its folder is there; otherwise nothing is selected, without an error.
   */
  const restoreUi = useLatestCallback(async (loaded: AppState | undefined): Promise<void> => {
    try {
      if (!loaded) return
      const [ui, live] = await Promise.all([api.getUiState(), api.getStatus().catch(() => null)])
      setCollapsed(new Set(ui.collapsed))
      if (ui.archivedOpen) setArchivedOpen(new Set(ui.archivedOpen))
      if (ui.sidebarFilter) setSidebarFilter((current) => current || (ui.sidebarFilter ?? ''))
      for (const [key, entry] of Object.entries(ui.panels)) {
        if (!panelsRef.current.has(key)) panelsRef.current.set(key, { ...DEFAULT_PANEL, ...entry })
      }
      if (ui.panelWidth !== undefined) setPanelFraction(clampFraction(ui.panelWidth))
      const target = ui.selected
      // The user may have picked something while this loaded: theirs wins.
      if (!target || selectedRef.current || !resolveTarget(loaded, target)) return
      if (live?.missing.includes(targetKey(target))) return
      void open(target, { quiet: true, state: loaded })
    } catch {
      // No saved UI state to restore: start as usual.
    } finally {
      uiRestored.current = true
    }
  })

  // The app state, then the UI as it was left.
  useEffect(() => {
    void (async () => {
      const loaded = await attempt(() => api.getState())
      if (loaded) setState(loaded)
      setStateLoaded(true)
      await restoreUi(loaded)
    })()
  }, [api, attempt, restoreUi])

  useEffect(() => {
    if (!uiRestored.current) return
    if (uiSaveTimer.current !== null) clearTimeout(uiSaveTimer.current)
    uiSaveTimer.current = setTimeout(() => {
      uiSaveTimer.current = null
      api.saveUiState(uiSnapshot()).catch(() => {})
    }, UI_SAVE_MS)
  }, [api, uiSnapshot, selected, collapsed, archivedOpen, sidebarFilter, panel, panelFraction])

  // A save still waiting goes out when the window closes or reloads (and if the App unmounts).
  useEffect(() => {
    window.addEventListener('beforeunload', saveUiNow)
    return () => {
      window.removeEventListener('beforeunload', saveUiNow)
      saveUiNow()
    }
  }, [saveUiNow])

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
    if (!target || isArchivedTarget(stateRef.current, target)) return
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

  const askName = (ask: NameAsk, submit: (name: string) => Promise<AppState>): void => {
    const id = openDialog({
      kind: 'name',
      ...ask,
      onSubmit: async (name) => {
        const next = await attempt(() => submit(name))
        if (!next) return
        setState(next)
        closeDialog(id)
      },
    })
  }

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

  const customizeTheme = (themeId: string): void => {
    const theme = state.themes.find((t) => t.id === themeId)
    if (!theme) return
    const style: ThemeStyle = {
      ...(theme.color ? { color: theme.color } : {}),
      ...(theme.icon ? { icon: theme.icon } : {}),
    }
    openDialog({ kind: 'themeStyle', themeId, themeName: theme.name, style })
  }

  const update = async (fn: () => Promise<AppState>): Promise<AppState | undefined> => {
    const next = await attempt(fn)
    if (next) setState(next)
    return next
  }

  const addPath = async (themeId: string, add: (themeId: string, path: string) => Promise<AppState>): Promise<void> => {
    const path = await attempt(() => api.pickDirectory())
    if (path) await update(() => add(themeId, path))
  }

  const cloneRepo = (themeId: string): void => {
    const theme = state.themes.find((t) => t.id === themeId)
    if (theme) openDialog({ kind: 'clone', themeId, themeName: theme.name })
  }

  /** Rejects (to the dialog, which shows why) when the clone fails. */
  const doClone = async (
    dialogId: number,
    themeId: string,
    url: string,
    parentDir: string,
    name: string,
  ): Promise<void> => {
    const next = await api.cloneRepo(themeId, url, parentDir, name)
    setState(next)
    setSettings((s) => ({ ...s, cloneDirectory: parentDir })) // main saved it too: the default next time
    closeDialog(dialogId)
    setCollapsed((prev) => {
      if (!prev.has(themeId)) return prev
      const open = new Set(prev)
      open.delete(themeId)
      return open
    })
    const theme = next.themes.find((t) => t.id === themeId)
    showInfo(`Cloned ${name}${theme ? ` into ${theme.name}` : ''}`)
  }

  /**
   * Runs `then` with the theme a new repository goes into: the only theme; the one the user picks when there are
   * several; or, when there are none yet, a new one the user names first.
   */
  const withTheme = (title: string, then: (theme: { id: string; name: string }) => void): void => {
    const { themes } = state
    if (themes.length === 1) return then(themes[0])
    // Dismissed before it answered: nothing follows, so it can't replace a dialog opened since.
    if (themes.length > 1) {
      const id = openDialog({
        kind: 'chooseTheme',
        title,
        onChoose: (themeId) => {
          if (!closeDialog(id)) return
          const theme = themes.find((t) => t.id === themeId)
          if (theme) then(theme)
        },
      })
      return
    }
    const id = openDialog({
      kind: 'name',
      title: 'New theme',
      placeholder: 'e.g. Client X',
      note: 'Repositories go into a theme: name one first. You can rename it later.',
      submitLabel: 'Create and continue',
      onSubmit: async (name) => {
        const next = await attempt(() => api.createTheme(name))
        if (!next) return
        setState(next)
        if (!closeDialog(id)) return
        const theme = next.themes.find((t) => t.name === name) ?? next.themes.at(-1)
        if (theme) then(theme)
      },
    })
  }
  const startAddRepo = (): void => withTheme('Add a repository', (theme) => void addPath(theme.id, api.addRepo))
  const startClone = (): void =>
    withTheme('Clone a repository', (theme) => openDialog({ kind: 'clone', themeId: theme.id, themeName: theme.name }))

  const removeTask = async (themeId: string, repoId: string, taskId: string, taskName: string): Promise<void> => {
    const work = await attempt(() => api.checkTaskRemoval(themeId, repoId, taskId))
    if (!work) return
    let dialogId: number | undefined
    const doRemove = async (deleteBranch: boolean): Promise<void> => {
      const next = await update(() => api.removeTask(themeId, repoId, taskId, deleteBranch))
      if (!next) return
      if (dialogId !== undefined) closeDialog(dialogId)
      clearSelectionIf((t) => t.taskId === taskId)
      refresh()
    }
    if (hasUnsavedWork(work)) dialogId = openDialog({ kind: 'removeTask', taskName, work, onConfirm: doRemove })
    else await doRemove(true)
  }

  /**
   * Archives a task: at once when its worktree is clean (main checks again, and refuses if that changed meanwhile);
   * after "Archive anyway" in a dialog when it has uncommitted or untracked files, or could not be checked, which
   * then discards them (`force`). A selected task stays selected and shows as archived.
   */
  const archiveTask = async (themeId: string, repoId: string, taskId: string, taskName: string): Promise<void> => {
    const work = await attempt(() => api.checkTaskRemoval(themeId, repoId, taskId))
    if (!work) return
    let dialogId: number | undefined
    const doArchive = async (force: boolean): Promise<void> => {
      const next = await update(() => api.archiveTask(themeId, repoId, taskId, force))
      if (!next) return
      if (dialogId !== undefined) closeDialog(dialogId)
      if (selectedRef.current?.taskId === taskId) {
        setTabs([])
        setSessionEnded(false)
      }
      refresh()
      showInfo(`Archived “${taskName}”`, {
        action: { label: 'Restore', run: () => restoreTask(themeId, repoId, taskId, taskName) },
      })
    }
    if (work.uncommittedFiles.length > 0 || work.warning)
      dialogId = openDialog({ kind: 'archiveTask', taskName, work, onConfirm: () => doArchive(true) })
    else await doArchive(false)
  }

  /** Recreates an archived task's worktree; a selected one is then opened, which starts its session. */
  const restoreTask = async (themeId: string, repoId: string, taskId: string, taskName: string): Promise<void> => {
    const next = await update(() => api.unarchiveTask(themeId, repoId, taskId))
    if (!next) return
    showInfo(`Restored “${taskName}”`)
    const current = selectedRef.current
    if (current?.taskId === taskId) void open(current, { state: next })
    else refresh()
  }

  /** Deletes an archived task and its branch, once confirmed; the dialog warns about commits only it has. */
  const deleteArchivedTask = async (
    themeId: string,
    repoId: string,
    taskId: string,
    taskName: string,
  ): Promise<void> => {
    const task = resolveTarget(stateRef.current, { themeId, itemId: repoId, taskId })?.task
    if (!task) return
    const work = await attempt(() => api.checkTaskRemoval(themeId, repoId, taskId))
    if (!work) return
    const id = openDialog({
      kind: 'deleteArchived',
      taskName,
      branch: task.branch,
      baseRef: task.baseRef,
      work,
      onConfirm: async () => {
        if (!(await update(() => api.removeTask(themeId, repoId, taskId, true)))) return
        closeDialog(id)
        clearSelectionIf((t) => t.taskId === taskId)
        showInfo(`Deleted “${taskName}” and its branch`)
      },
    })
  }

  /** The selected task with its ids, for the palette's archive actions. */
  const withSelectedTask = (
    fn: (themeId: string, repoId: string, taskId: string, taskName: string) => unknown,
  ): void => {
    const target = selectedRef.current
    const task = target?.taskId ? resolveTarget(stateRef.current, target)?.task : undefined
    if (target?.taskId && task) void fn(target.themeId, target.itemId, target.taskId, task.name)
  }

  /**
   * Removing a theme, repo or folder: refused at once while it has tasks (as main would), otherwise confirmed in a
   * dialog, then offered back for ACTION_MS by an "Undo" toast that restores it as it was, in the same place.
   */
  const confirmRemoval = (
    ask: Omit<Extract<DialogBody, { kind: 'confirmRemove' }>, 'kind' | 'onConfirm'>,
    remove: () => Promise<AppState>,
    restore: () => Promise<AppState>,
    clear: (t: Target) => boolean,
  ): void => {
    const label = `${ask.what === 'repo' ? 'repository' : ask.what} “${ask.name}”`
    const id = openDialog({
      kind: 'confirmRemove',
      ...ask,
      onConfirm: async () => {
        if (!(await update(remove))) return
        closeDialog(id)
        clearSelectionIf(clear)
        refresh()
        showInfo(`Removed ${label}`, {
          action: {
            label: 'Undo',
            run: async () => {
              if (await update(restore)) showInfo(`Restored ${label}`)
            },
          },
        })
      },
    })
  }

  const removeTheme = (themeId: string): void => {
    const index = state.themes.findIndex((t) => t.id === themeId)
    const theme = state.themes[index]
    if (!theme) return
    if (theme.items.some((i) => i.kind === 'repo' && i.tasks.length > 0))
      return showError(`Remove the tasks in "${theme.name}" first`)
    const repos = theme.items.filter((i) => i.kind === 'repo').length
    const folders = theme.items.length - repos
    const contents = [
      repos ? plural(repos, 'repository', 'repositories') : '',
      folders ? plural(folders, 'folder') : '',
    ].filter(Boolean)
    // Put back next to its neighbours as they are at undo time (other removals may have been undone meanwhile).
    const place = placeOf(
      state.themes.map((t) => t.id),
      index,
    )
    confirmRemoval(
      { what: 'theme', name: theme.name, contents: contents.join(' and ') || undefined },
      () => api.removeTheme(themeId),
      () =>
        api.restoreTheme(
          theme,
          placeBack(
            stateRef.current.themes.map((t) => t.id),
            place,
          ),
        ),
      (t) => t.themeId === themeId,
    )
  }

  const removeItem = (themeId: string, itemId: string): void => {
    const theme = state.themes.find((t) => t.id === themeId)
    const index = theme?.items.findIndex((i) => i.id === itemId) ?? -1
    const item = theme?.items[index]
    if (!theme || !item) return
    if (item.kind === 'repo' && item.tasks.length > 0) return showError(`Remove the tasks in "${item.name}" first`)
    const place = placeOf(
      theme.items.map((i) => i.id),
      index,
    )
    confirmRemoval(
      { what: item.kind, name: item.name, themeName: theme.name, path: item.path },
      () => api.removeItem(themeId, itemId),
      () => {
        const now = stateRef.current.themes.find((t) => t.id === themeId)
        return api.restoreItem(
          themeId,
          item,
          now
            ? placeBack(
                now.items.map((i) => i.id),
                place,
              )
            : index,
        )
      },
      (t) => t.itemId === itemId,
    )
  }

  const openSettings = (): void => void openDialog({ kind: 'settings' })

  const newTask = (themeId: string, repoId: string): void => {
    const repo = state.themes.find((t) => t.id === themeId)?.items.find((i) => i.id === repoId)
    if (repo?.kind === 'repo') openDialog({ kind: 'newTask', themeId, repoId, repoName: repo.name })
  }

  /**
   * Creates the task and opens it, unless another dialog or overlay was opened while it was being created (the
   * user moved on: the selection doesn't jump under them, and the new task is in the sidebar). Dismissing the
   * dialog alone doesn't count: the task they asked for still opens.
   */
  const createTask = async (
    dialogId: number,
    themeId: string,
    repoId: string,
    name: string,
    options: NewTaskOptions,
  ): Promise<void> => {
    const next = await update(() => api.createTask(themeId, repoId, name, options))
    if (!next) return
    const movedOn = modalEpoch.current !== dialogId
    closeDialog(dialogId)
    const repo = next.themes.find((t) => t.id === themeId)?.items.find((i) => i.id === repoId)
    const task = repo?.kind === 'repo' ? repo.tasks.find((t) => t.name === name) : undefined
    if (task && !movedOn) void open({ themeId, itemId: repoId, taskId: task.id })
  }

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
    if (!target || isArchivedTarget(stateRef.current, target)) return
    void attempt(async () => {
      if (where === 'editor') await api.openInEditor(target)
      else await api.openInFileManager(target)
      showInfo(where === 'editor' ? 'Opening in the editor…' : 'Opening the file manager…')
    })
  }

  /**
   * Runs a git action on a task, marking it busy (the header's Git buttons are off meanwhile), showing a failure
   * as an error toast and refreshing the git badges after, whatever the outcome. Undefined when it failed or the
   * task already had an action running.
   */
  const gitAction = async <T,>(target: Target, kind: GitActionKind, fn: () => Promise<T>): Promise<T | undefined> => {
    const key = targetKey(target)
    if (gitBusyRef.current[key]) return undefined
    const mark = (next: Record<string, GitActionKind>): void => {
      gitBusyRef.current = next
      setGitBusy(next)
    }
    mark({ ...gitBusyRef.current, [key]: kind })
    try {
      return await attempt(fn)
    } finally {
      const rest = { ...gitBusyRef.current }
      delete rest[key]
      mark(rest)
      refreshGit()
    }
  }

  /** The selected target when it is a repo task, with the task. */
  const taskOfSelection = (): { target: Target; task: Task } | null => {
    const target = selectedRef.current
    const task = target?.taskId ? resolveTarget(state, target)?.task : undefined
    return target && task ? { target, task } : null
  }

  const commitAll = (): void => {
    const found = taskOfSelection()
    if (found)
      openDialog({ kind: 'commit', target: found.target, taskName: found.task.name, branch: found.task.branch })
  }

  const doCommit = async (dialogId: number, target: Target, message: string): Promise<void> => {
    const result = await gitAction(target, 'commit', () => api.commitAll(target, message))
    if (!result) return
    closeDialog(dialogId)
    showInfo(`Committed ${plural(result.files, 'file')}`)
  }

  const push = async (): Promise<void> => {
    const found = taskOfSelection()
    if (!found) return
    const result = await gitAction(found.target, 'push', () => api.pushTask(found.target))
    if (result) showInfo(`Pushed ${result.branch}`)
  }

  const openPullRequest = async (): Promise<void> => {
    const found = taskOfSelection()
    if (!found) return
    if (!gitTools.gh) return showError(GH_INSTALL_HINT)
    const result = await gitAction(found.target, 'pr', () => api.createPullRequest(found.target))
    if (!result) return
    if (await attempt(async () => (await api.openExternal(result.url), true)))
      showInfo(result.created ? `Created a pull request for ${found.task.branch}` : 'Opened the pull request')
  }

  const updateFromBase = async (): Promise<void> => {
    const found = taskOfSelection()
    if (!found) return
    const { target, task } = found
    const result = await gitAction(target, 'update', () => api.updateFromBase(target))
    if (!result) return
    if (result.kind === 'upToDate') showInfo(`Already up to date with ${result.baseRef}`)
    else if (result.kind === 'updated') {
      const verb = result.strategy === 'rebase' ? `Rebased onto ${result.baseRef}` : `Merged ${result.baseRef}`
      showInfo(`${verb} (${plural(result.commits, 'new commit')})`)
    } else if (dialogRef.current || overlayOpenRef.current) {
      // Something was opened while it ran: say so rather than replace it. Running it again shows the dialog.
      showError(
        `Updating ${task.branch} stopped on conflicts in ${plural(result.files.length, 'file')} and was undone; ` +
          'run "Update from base" again to have Claude resolve them',
      )
    } else openDialog({ kind: 'conflicts', target, branch: task.branch, result })
  }

  const askClaudeToResolve = async (
    dialogId: number,
    target: Target,
    result: Extract<UpdateResult, { kind: 'conflict' }>,
  ): Promise<void> => {
    const tabs = await attempt(() => api.askClaudeToResolve(target, result.strategy, result.files))
    if (!tabs) return
    closeDialog(dialogId)
    if (sameTarget(selectedRef.current, target)) setTabs(tabs)
    showInfo('Asked Claude to resolve the conflicts')
  }

  // Review comments: kept per target in `reviews`; the dialog asks for the note.

  const setComments = (key: string, change: (comments: ReviewComment[]) => ReviewComment[]): void =>
    setReviews((all) => {
      const next = { ...all, [key]: change(all[key] ?? []) }
      if (next[key].length === 0) delete next[key]
      return next
    })

  /** Asks for the note on `draft`'s lines; `done` (the viewer clears its selection) once it is added. */
  const addComment = (target: Target, draft: ReviewDraft, done: () => void): void => {
    const id = openDialog({
      kind: 'reviewComment',
      location: reviewLocation(draft),
      onSave: (note) => {
        setComments(targetKey(target), (comments) => [...comments, { ...draft, id: ++reviewIds.current, note }])
        closeDialog(id)
        done()
      },
    })
  }

  const editComment = (target: Target, comment: ReviewComment): void => {
    const id = openDialog({
      kind: 'reviewComment',
      location: reviewLocation(comment),
      initial: comment.note,
      onSave: (note) => {
        setComments(targetKey(target), (comments) => comments.map((c) => (c.id === comment.id ? { ...c, note } : c)))
        closeDialog(id)
      },
    })
  }

  const deleteComment = (target: Target, comment: ReviewComment): void =>
    setComments(targetKey(target), (comments) => comments.filter((c) => c.id !== comment.id))

  /**
   * Pastes the target's comments into its Claude tab (main refuses while Claude is busy or waiting, or without a
   * Claude tab), then shows that tab and focuses the terminal, for the user to read them and press Enter. The
   * comments sent are dropped; any added meanwhile stay.
   */
  const sendReview = async (target: Target): Promise<void> => {
    const key = targetKey(target)
    const comments = reviews[key] ?? []
    if (comments.length === 0 || reviewSendingRef.current.has(key)) return
    reviewSendingRef.current.add(key)
    setReviewSending((s) => ({ ...s, [key]: true }))
    try {
      const tabs = await attempt(() => api.sendToClaude(target, formatReview(comments)))
      if (!tabs) return
      const sent = new Set(comments.map((c) => c.id))
      setComments(key, (current) => current.filter((c) => !sent.has(c.id)))
      if (sameTarget(selectedRef.current, target)) {
        setTabs(tabs)
        setTerminalFocus((n) => n + 1)
      }
      showInfo(
        `Pasted ${plural(comments.length, 'review comment')} into Claude's prompt: read them and press Enter to send`,
      )
    } finally {
      reviewSendingRef.current.delete(key)
      setReviewSending((s) => {
        const next = { ...s }
        delete next[key]
        return next
      })
    }
  }

  const copyReview = async (target: Target): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatReview(reviews[targetKey(target)] ?? []))
      showInfo('Copied the review comments')
    } catch {
      showError('Could not copy the review comments to the clipboard')
    }
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
      case 'searchFiles':
        return searchInFiles()
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

  const hasActiveTab = tabs.some((t) => t.active)
  // Built once per change of what it lists, not per App render: the palette re-runs its fuzzy matching (over up
  // to 50k files) whenever its commands change.
  const paletteCommands = useMemo(
    () => (paletteOpen ? buildPaletteCommands(state, selected, hasActiveTab, gitTools.gh, tmuxSocket) : []),
    [paletteOpen, state, selected, hasActiveTab, gitTools.gh, tmuxSocket],
  )

  /** Shows or hides the status bar at once, then saves it; a failed save puts it back. */
  const toggleStatusBar = (): void => {
    const showStatusBar = !settings.showStatusBar
    setSettings((s) => ({ ...s, showStatusBar }))
    api.updateSettings({ showStatusBar }).then(
      (saved) => setSettings((s) => ({ ...s, showStatusBar: saved.showStatusBar })),
      (err) => {
        setSettings((s) => ({ ...s, showStatusBar: !showStatusBar }))
        showError(err)
      },
    )
  }

  const saveSettings = async (dialogId: number, next: Partial<Settings>): Promise<void> => {
    const saved = await attempt(() => api.updateSettings(next))
    if (!saved) return
    setSettings(saved)
    closeDialog(dialogId)
    showInfo('Settings saved')
  }

  const editNotes = (target: Target): void => {
    const task = resolveTarget(state, target)?.task
    if (!task || !target.taskId) return
    const { themeId, itemId, taskId } = target
    const id = openDialog({
      kind: 'notes',
      taskName: task.name,
      notes: task.notes ?? '',
      onSave: async (notes) => {
        if (await update(() => api.setTaskNotes(themeId, itemId, taskId, notes))) closeDialog(id)
      },
    })
  }

  const copiesFor = (target: Target | null): CopyEntry[] => copiesOf(state, target, tmuxSocket)

  const copy = async (entry: CopyEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.text)
      showInfo(`Copied ${entry.what}`)
    } catch {
      showError(`Could not copy the ${entry.what} to the clipboard`)
    }
  }

  /** The status bar's branch: the checked-out one it shows, copied like the header's "Branch" button. */
  const copyBranch = (branch: string): void => {
    const entry = copiesFor(selectedRef.current).find((e) => e.kind === 'branch')
    if (entry) void copy({ ...entry, text: branch })
  }

  /** The selected target with the tab at `index`, or its active tab; null when there is none. */
  const transcriptTab = (index?: number): { target: Target; index: number } | null => {
    const target = selectedRef.current
    const tab = index ?? tabs.find((t) => t.active)?.index
    return target && tab !== undefined ? { target, index: tab } : null
  }

  const copyTranscript = async (index?: number): Promise<void> => {
    const tab = transcriptTab(index)
    const transcript = tab && (await attempt(() => api.copyTranscript(tab.target, tab.index)))
    if (!transcript) return
    try {
      await navigator.clipboard.writeText(transcript.text)
    } catch {
      return showError('Could not copy the transcript to the clipboard')
    }
    showInfo(`Copied ${plural(transcript.lines, 'line')}${transcriptCut(transcript)}`)
  }

  /** Main shows the save dialog; null: the user cancelled it. */
  const saveTranscript = async (index?: number): Promise<void> => {
    const tab = transcriptTab(index)
    const saved = tab && (await attempt(() => api.saveTranscript(tab.target, tab.index)))
    if (saved) showInfo(`Saved to ${saved.path}${transcriptCut(saved)}`)
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
    else if (action.type === 'searchFiles') searchInFiles()
    else if (action.type === 'newTab') void tabAction((t) => api.newTab(t))
    else if (action.type === 'restartClaude') void tabAction((t) => api.restartClaude(t))
    else if (action.type === 'renameTask') renameSelectedTask()
    else if (action.type === 'settings') openSettings()
    else if (action.type === 'usage') setUsageOpen(true)
    else if (action.type === 'openEditor') openExternally('editor')
    else if (action.type === 'fileManager') openExternally('fileManager')
    else if (action.type === 'commit') commitAll()
    else if (action.type === 'push') void push()
    else if (action.type === 'openPr') void openPullRequest()
    else if (action.type === 'update') void updateFromBase()
    else if (action.type === 'toggleStatusBar') toggleStatusBar()
    else if (action.type === 'copyTranscript') void copyTranscript()
    else if (action.type === 'saveTranscript') void saveTranscript()
    else if (action.type === 'archiveTask') withSelectedTask(archiveTask)
    else if (action.type === 'restoreTask') withSelectedTask(restoreTask)
    else if (action.type === 'deleteArchivedTask') withSelectedTask(deleteArchivedTask)
    else if (action.type === 'customizeTheme') {
      if (selectedRef.current) customizeTheme(selectedRef.current.themeId)
    } else if (action.type === 'copy') {
      const entry = copiesFor(selectedRef.current).find((e) => e.kind === action.kind)
      if (entry) void copy(entry)
    } else setHelpOpen(true)
  }

  if (prereqs && !prereqs.ok) return <PrereqScreen result={prereqs} onRetry={checkPrereqs} />

  // While a dialog or overlay is up, everything behind it is inert: Tab and Shift+Tab can't leave the modal for the
  // sidebar or the terminal (whose textarea would send keys, Escape included, to Claude), and clicks don't land
  // there either. The terminal also drops keys itself meanwhile.
  const modalOpen = dialog !== null || overlayOpen

  const header = selected ? describeTarget(state, selected) : null
  const selectedTask = selected ? resolveTarget(state, selected)?.task : undefined
  const item = selected
    ? state.themes.find((t) => t.id === selected.themeId)?.items.find((i) => i.id === selected.itemId)
    : undefined
  const isRepo = item?.kind === 'repo' && selected?.taskId !== undefined
  const sessionFlags = effectiveSessionFlags(settings)

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
        onCustomizeTheme={customizeTheme}
        onRemoveTheme={removeTheme}
        onAddRepo={(themeId) => void addPath(themeId, api.addRepo)}
        onCloneRepo={cloneRepo}
        onAddFolder={(themeId) => void addPath(themeId, api.addFolder)}
        onRemoveItem={removeItem}
        onAddTask={newTask}
        onRenameTask={renameTask}
        onRemoveTask={(themeId, repoId, taskId, taskName) => void removeTask(themeId, repoId, taskId, taskName)}
        onArchiveTask={(themeId, repoId, taskId, taskName) => void archiveTask(themeId, repoId, taskId, taskName)}
        archivedOpen={archivedOpen}
        onToggleArchived={toggleArchived}
        onRestoreTask={(themeId, repoId, taskId, taskName) => void restoreTask(themeId, repoId, taskId, taskName)}
        onDeleteArchivedTask={(themeId, repoId, taskId, taskName) =>
          void deleteArchivedTask(themeId, repoId, taskId, taskName)
        }
        onOpenSettings={openSettings}
        onOpenUsage={() => setUsageOpen(true)}
        inert={modalOpen}
      />
      <main className="main" inert={modalOpen}>
        {selected && selectedTask && isArchived(selectedTask) && item ? (
          <ArchivedTaskView
            key={targetKey(selected)}
            task={selectedTask}
            repoName={item.name}
            onRestore={() => restoreTask(selected.themeId, selected.itemId, selectedTask.id, selectedTask.name)}
            onDelete={() =>
              void deleteArchivedTask(selected.themeId, selected.itemId, selectedTask.id, selectedTask.name)
            }
          />
        ) : selected && header ? (
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
              sessionFlags={sessionFlags}
              usage={usage?.key === targetKey(selected) ? usage.summary : undefined}
              onOpenUsage={() => setUsageOpen(true)}
              git={selectedTask ? gitStatus[selectedTask.id] : undefined}
              baseRef={selectedTask?.baseRef}
              session={sessionState(status, targetKey(selected))}
              gitActions={
                selectedTask
                  ? {
                      branch: selectedTask.branch,
                      baseRef: selectedTask.baseRef,
                      updateStrategy: settings.updateStrategy,
                      busy: gitBusy[targetKey(selected)],
                      ghAvailable: gitTools.gh,
                      onCommit: commitAll,
                      onPush: () => void push(),
                      onOpenPr: () => void openPullRequest(),
                      onUpdate: () => void updateFromBase(),
                    }
                  : undefined
              }
            />
            <TabBar
              tabs={tabs}
              onSelect={(index) => void tabAction((t) => api.selectTab(t, index))}
              onClose={(index) => void tabAction((t) => api.closeTab(t, index))}
              onNew={() => void tabAction((t) => api.newTab(t))}
              onRestartClaude={() => void tabAction((t) => api.restartClaude(t))}
              onCopyTranscript={(index) => void copyTranscript(index)}
              onSaveTranscript={(index) => void saveTranscript(index)}
              panelOpen={panel.open}
              onTogglePanel={togglePanel}
            />
            <div className="workspace">
              <div className="terminal-area">
                <TerminalView
                  api={api}
                  sessionKey={targetKey(selected)}
                  fontSize={settings.terminalFontSize}
                  modalOpen={modalOpen}
                  focusSeq={terminalFocus}
                />
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
                        searchFocus={searchFocus}
                        takeSearchFocus={takeSearchFocus}
                        review={{
                          comments: reviews[targetKey(selected)] ?? NO_COMMENTS,
                          sending: Boolean(reviewSending[targetKey(selected)]),
                          onComment: (draft, done) => addComment(selected, draft, done),
                          onEdit: (comment) => editComment(selected, comment),
                          onDelete: (comment) => deleteComment(selected, comment),
                          onSend: () => void sendReview(selected),
                          onCopy: () => void copyReview(selected),
                        }}
                      />
                    </Suspense>
                  </aside>
                </>
              )}
            </div>
            {settings.showStatusBar && item && (
              <StatusBar
                task={
                  selectedTask
                    ? {
                        branch: selectedTask.branch,
                        baseRef: selectedTask.baseRef,
                        git: gitStatus[selectedTask.id],
                      }
                    : undefined
                }
                path={selectedTask?.worktreePath ?? item.path}
                session={sessionState(status, targetKey(selected))}
                tabs={tabs.length}
                todayCost={usage?.key === targetKey(selected) ? usage.summary.today.cost : undefined}
                skipPermissions={sessionFlags.skipPermissions}
                onCopyBranch={copyBranch}
                onOpenChanges={() => updatePanel({ open: true, tab: 'changes' })}
                onOpenUsage={() => setUsageOpen(true)}
              />
            )}
          </>
        ) : !stateLoaded ? null : state.themes.length === 0 ? (
          <Welcome
            onCreateTheme={newTheme}
            onAddRepo={startAddRepo}
            onCloneRepo={startClone}
            onShowShortcuts={() => setHelpOpen(true)}
          />
        ) : (
          <Home
            state={state}
            status={status}
            onOpen={(target) => void open(target)}
            onCreateTheme={newTheme}
            onAddRepo={startAddRepo}
            onCloneRepo={startClone}
            onOpenPalette={() => setPaletteOpen(true)}
          />
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
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'newTask' && (
        <NewTaskDialog
          repoName={dialog.repoName}
          loadBranches={() => api.listBranches(dialog.themeId, dialog.repoId)}
          onSubmit={(name, options) => createTask(dialog.id, dialog.themeId, dialog.repoId, name, options)}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'removeTask' && (
        <RemoveTaskDialog
          taskName={dialog.taskName}
          work={dialog.work}
          onConfirm={dialog.onConfirm}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'archiveTask' && (
        <ArchiveTaskDialog
          taskName={dialog.taskName}
          work={dialog.work}
          onConfirm={dialog.onConfirm}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'deleteArchived' && (
        <DeleteArchivedTaskDialog
          taskName={dialog.taskName}
          branch={dialog.branch}
          baseRef={dialog.baseRef}
          work={dialog.work}
          onConfirm={dialog.onConfirm}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'clone' && (
        <CloneRepoDialog
          themeName={dialog.themeName}
          initialParent={settings.cloneDirectory}
          pickDirectory={() => api.pickDirectory()}
          onClone={(url, parentDir, name) => doClone(dialog.id, dialog.themeId, url, parentDir, name)}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'chooseTheme' && (
        <ChooseThemeDialog
          title={dialog.title}
          themes={state.themes}
          onChoose={dialog.onChoose}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'themeStyle' && (
        <ThemeStyleDialog
          themeName={dialog.themeName}
          initial={dialog.style}
          onSave={async (style) => {
            if (await update(() => api.customizeTheme(dialog.themeId, style))) closeDialog(dialog.id)
          }}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'confirmRemove' && (
        <ConfirmRemoveDialog
          kind={dialog.what}
          name={dialog.name}
          themeName={dialog.themeName}
          path={dialog.path}
          contents={dialog.contents}
          onConfirm={dialog.onConfirm}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'notes' && (
        <NotesDialog
          taskName={dialog.taskName}
          initial={dialog.notes}
          onSave={dialog.onSave}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'reviewComment' && (
        <ReviewCommentDialog
          location={dialog.location}
          initial={dialog.initial}
          onSave={dialog.onSave}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'commit' && (
        <CommitDialog
          taskName={dialog.taskName}
          branch={dialog.branch}
          loadChanges={() => api.listChanges(dialog.target, 'uncommitted')}
          onCommit={(message) => doCommit(dialog.id, dialog.target, message)}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'conflicts' && (
        <ConflictDialog
          branch={dialog.branch}
          baseRef={dialog.result.baseRef}
          strategy={dialog.result.strategy}
          files={dialog.result.files}
          onAskClaude={() => askClaudeToResolve(dialog.id, dialog.target, dialog.result)}
          onClose={() => closeDialog(dialog.id)}
        />
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog
          settings={settings}
          onSave={(next) => saveSettings(dialog.id, next)}
          onCancel={() => closeDialog(dialog.id)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
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
