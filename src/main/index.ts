import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as nodePty from 'node-pty'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Orchestrator } from './app/orchestrator'
import { FilesService } from './files/filesService'
import { GhService } from './git/gh'
import { GitService } from './git/gitService'
import { registerIpc } from './ipc'
import { createLauncher, systemLaunchDeps } from './launch'
import { createDesktopNotifier } from './notify/desktop'
import { NotificationWatcher } from './notify/watcher'
import { promptsDir, settingsFile, stateFile, tmuxConfFile, TMUX_SOCKET, uiStateFile, worktreesRoot } from './paths'
import { PromptFiles } from './promptFiles'
import { PtyService } from './pty/ptyService'
import { ensureUtf8Locale, loadLoginShellPath } from './shellEnv'
import { FileStore } from './store/fileStore'
import { SettingsService, SettingsStore } from './store/settings'
import { UiStateStore } from './store/uiState'
import { TmuxService } from './tmux/tmuxService'
import { UsageService } from './usage/usageService'
import { isAppUrl, isHttpUrl } from './urls'

let mainWindow: BrowserWindow | null = null
let ptyService: PtyService | null = null
let notificationWatcher: NotificationWatcher | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#1e1e1e',
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
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
  const orchestrator = new Orchestrator({
    store: new FileStore(stateFile()),
    git: new GitService(),
    gh: new GhService(), // looks gh up on PATH once, on first use (after loadLoginShellPath)
    tmux,
    pty: ptyService,
    files: new FilesService(),
    settings,
    ui: new UiStateStore(uiStateFile()),
    launcher: createLauncher(systemLaunchDeps((path) => shell.openPath(path))),
    usage: new UsageService(), // reads $CLAUDE_CONFIG_DIR or ~/.claude, never writes there
    promptFiles,
    worktreesRoot: worktreesRoot(),
    pathExists: existsSync,
  })
  await orchestrator.init()

  registerIpc({ app: orchestrator, pty: ptyService, getWindow: () => mainWindow })
  buildMenu()

  // Desktop notifications when a background task's Claude finishes or waits for input (Settings.notifications).
  notificationWatcher = new NotificationWatcher({
    getStatus: () => orchestrator.getStatus(),
    getState: () => orchestrator.getState(),
    getSettings: () => settings.get(),
    currentTarget: () => orchestrator.currentTarget(),
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    notify: createDesktopNotifier({
      getWindow: () => mainWindow ?? (mainWindow = createWindow()),
      ...(process.platform === 'linux' ? { icon } : {}),
    }),
  })
  notificationWatcher.start()

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

// Detach only: tmux sessions (and Claude) keep running after the app closes.
app.on('before-quit', () => {
  notificationWatcher?.stop()
  ptyService?.detach()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
