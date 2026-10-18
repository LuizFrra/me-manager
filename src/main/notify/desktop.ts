import { Notification, type BrowserWindow } from 'electron'
import { SELECT_TARGET } from '../../shared/ipc'
import type { DesktopNotice } from './watcher'

/** Shown notifications kept referenced (see below); older ones are let go past this many. */
const MAX_LIVE = 20

export interface DesktopNotifierOptions {
  /** The app window; created again if it was closed (macOS keeps the app running without one). */
  getWindow: () => BrowserWindow
  /** Shown in the notification on Linux. */
  icon?: string
}

/**
 * Native notifications from the main process: no permission prompt in Electron on Linux (libnotify) or macOS
 * (Notification Center). Clicking one brings the window to the front and tells the renderer to select the target.
 */
export function createDesktopNotifier({ getWindow, icon }: DesktopNotifierOptions): (notice: DesktopNotice) => void {
  // A notification that gets garbage-collected loses its click handler, so keep the shown ones referenced.
  const live = new Set<Notification>()
  return (notice) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: notice.title, body: notice.body, ...(icon ? { icon } : {}) })
    const release = (): void => void live.delete(notification)
    notification.on('click', () => {
      release()
      const win = getWindow()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      const select = (): void => win.webContents.send(SELECT_TARGET, notice.target)
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', select)
      else select()
    })
    notification.on('close', release)
    live.add(notification)
    if (live.size > MAX_LIVE) live.delete(live.values().next().value!)
    notification.show()
  }
}
