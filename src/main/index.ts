import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as nodePty from 'node-pty'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { followAppearance } from './appearance'
import { Orchestrator } from './app/orchestrator'
import { FilesService } from './files/filesService'
import { GhService } from './git/gh'
import { GitService } from './git/gitService'
import { BUDGET_ALERT } from '../shared/ipc'
import { APPEARANCE_BACKGROUND } from '../shared/appearance'
import { registerIpc } from './ipc'
import { createLauncher, systemLaunchDeps } from './launch'
import { createDesktopNotifier } from './notify/desktop'
import { loadPage } from './pageLoad'
import { BudgetWatcher } from './notify/budgetWatcher'
import { NotificationWatcher } from './notify/watcher'
import {
  budgetAlertsFile,
  promptsDir,
  settingsFile,
  stateFile,
  tmuxConfFile,
  TMUX_SOCKET,
  uiStateFile,
  usageCacheFile,
  worktreesRoot,
} from './paths'
import { PromptFiles } from './promptFiles'
import { PtyService } from './pty/ptyService'
import { ensureUtf8Locale, loadLoginShellPath } from './shellEnv'
import { FileStore } from './store/fileStore'
import { BudgetAlertStore } from './store/budgetAlerts'
import { SettingsService, SettingsStore } from './store/settings'
import { UiStateStore } from './store/uiState'
import { TmuxService } from './tmux/tmuxService'
import { UsageService } from './usage/usageService'
import { isAppUrl, isHttpUrl } from './urls'

let mainWindow: BrowserWindow | null = null
let ptyService: PtyService | null = null
/** The orchestrator once started, for the quit handler. */
let started: Orchestrator | null = null
/** Set once quitting waited for the changes still running (or the user quit a second time): the next quit goes. */
let quitReady = false
/** How long quitting waits for changes still running (a task being created or removed), so none is left half done. */
const QUIT_WAIT_MS = 15_000
let notificationWatcher: NotificationWatcher | null = null
let budgetWatcher: BudgetWatcher | null = null
/** The window colour for the current appearance (see followAppearance); dark until the settings are loaded. */
let windowBackground = (): string => APPEARANCE_BACKGROUND.dark

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: windowBackground(),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // Never open new windows; only http(s) links go to the system browser.
  win.webContents.setWindowOpenHandler((details) => {
    if (isHttpUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // The window has the preload API, so it must never navigate away from the app's own page.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, win.webContents.getURL())) event.preventDefault()
  })
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  // Without its page the window would never show: say why, and quit rather than linger as an invisible process.
  void loadPage(
    () => (devUrl ? win.loadURL(devUrl) : win.loadFile(join(__dirname, '../renderer/index.html'))),
    (message) => {
      dialog.showErrorBox('me-manager could not load its window', message)
      app.quit()
    },
  )
  return win
}

/**
 * macOS: standard menus so Cmd+C/V/Q work (the terminal uses Ctrl, so there is no conflict).
 * Linux: no menu, because accelerators like Ctrl+C / Ctrl+R would be stolen from the terminal.
 */
function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  // A View menu without the page-zoom items: Cmd+= / Cmd+- / Cmd+0 zoom the terminal font (renderer shortcuts).
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function bootstrap(): Promise<void> {
  electronApp.setAppUserModelId('com.me-manager.app')
  // If launched from inside a Claude Code session, don't let `claude` think it is nested.
  delete process.env.CLAUDECODE
  await loadLoginShellPath()
  // Before any tmux command, so the tmux server and `claude` inherit a UTF-8 locale.
  ensureUtf8Locale()

  const tmux = new TmuxService(TMUX_SOCKET, tmuxConfFile())
  await tmux.ensureConfig()
  const promptFiles = new PromptFiles(promptsDir())
  await promptFiles.sweep()
  ptyService = new PtyService(nodePty.spawn)
  const settings = new SettingsService(new SettingsStore(settingsFile()))
  await settings.init()
  // Before the window exists, so its first frame and the page's prefers-color-scheme already match the setting.
  windowBackground = followAppearance({ theme: nativeTheme, settings, getWindow: () => mainWindow })
  const orchestrator = new Orchestrator({
    store: new FileStore(stateFile()),
    git: new GitService(),
    gh: new GhService(), // looks gh up on PATH when asked (after loadLoginShellPath), until found
    tmux,
    pty: ptyService,
    files: new FilesService(),
    settings,
    ui: new UiStateStore(uiStateFile()),
    launcher: createLauncher(systemLaunchDeps((path) => shell.openPath(path))),
    usage: new UsageService({ cacheFile: usageCacheFile() }), // reads $CLAUDE_CONFIG_DIR or ~/.claude, never writes there
    promptFiles,
    worktreesRoot: worktreesRoot(),
    pathExists: existsSync,
  })
  await orchestrator.init()
  started = orchestrator

  registerIpc({ app: orchestrator, pty: ptyService, getWindow: () => mainWindow })
  buildMenu()

  // Desktop notifications when a background task's Claude finishes or waits for input (Settings.notifications).
  const notify = createDesktopNotifier({
    getWindow: () => mainWindow ?? (mainWindow = createWindow()),
    ...(process.platform === 'linux' ? { icon } : {}),
  })
  notificationWatcher = new NotificationWatcher({
    getStatus: () => orchestrator.getStatus(),
    lastStatus: () => orchestrator.lastStatus,
    getState: () => orchestrator.getState(),
    getSettings: () => settings.get(),
    currentTarget: () => orchestrator.currentTarget(),
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    notify,
  })
  notificationWatcher.start()
  // And when a task or the day reaches 80% or 100% of its budget (also a toast while the window is focused).
  budgetWatcher = new BudgetWatcher({
    getBudgets: () => orchestrator.getBudgets(),
    getState: () => orchestrator.getState(),
    getSettings: () => settings.get(),
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    notify,
    showInApp: (alert) => mainWindow?.webContents.send(BUDGET_ALERT, alert),
    store: new BudgetAlertStore(budgetAlertsFile()),
  })
  budgetWatcher.start()

  // zoom: true only stops the toolkit from swallowing Mod+- and Mod+Shift+= (there is no page zoom: no menu item
  // has it), so they reach the renderer's terminal zoom.
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window, { zoom: true }))
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}

// .catch (not a second .then argument) so a failing bootstrap also quits instead of leaving a windowless process.
app
  .whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error(err)
    // Otherwise a GUI launch just exits with no explanation.
    dialog.showErrorBox('me-manager failed to start', String(err))
    app.quit()
  })

// Detach only: tmux sessions (and Claude) keep running after the app closes. A change still running (a task being
// created, archived or removed) is waited for, up to QUIT_WAIT_MS, so it isn't left half done; a clone is cancelled
// (it may take minutes), and waited for until git has stopped. Quitting again doesn't wait.
app.on('before-quit', (event) => {
  notificationWatcher?.stop()
  budgetWatcher?.stop()
  ptyService?.detach()
  if (quitReady || !started?.busy()) return
  event.preventDefault()
  quitReady = true
  started.cancelClones()
  void started.whenIdle(QUIT_WAIT_MS).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
