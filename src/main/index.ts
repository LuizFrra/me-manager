import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as nodePty from 'node-pty'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Orchestrator } from './app/orchestrator'
import { FilesService } from './files/filesService'
import { GitService } from './git/gitService'
import { registerIpc } from './ipc'
import { createLauncher, systemLaunchDeps } from './launch'
import { settingsFile, stateFile, tmuxConfFile, TMUX_SOCKET, worktreesRoot } from './paths'
import { PtyService } from './pty/ptyService'
import { ensureUtf8Locale, loadLoginShellPath } from './shellEnv'
import { FileStore } from './store/fileStore'
import { SettingsService, SettingsStore } from './store/settings'
import { TmuxService } from './tmux/tmuxService'
import { isAppUrl, isHttpUrl } from './urls'

let mainWindow: BrowserWindow | null = null
let ptyService: PtyService | null = null

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
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
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
  ptyService = new PtyService(nodePty.spawn)
  const settings = new SettingsService(new SettingsStore(settingsFile()))
  await settings.init()
  const orchestrator = new Orchestrator({
    store: new FileStore(stateFile()),
    git: new GitService(),
    tmux,
    pty: ptyService,
    files: new FilesService(),
    settings,
    launcher: createLauncher(systemLaunchDeps((path) => shell.openPath(path))),
    worktreesRoot: worktreesRoot(),
    pathExists: existsSync,
  })
  await orchestrator.init()

  registerIpc({ app: orchestrator, pty: ptyService, getWindow: () => mainWindow })
  buildMenu()

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
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
app.on('before-quit', () => ptyService?.detach())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
