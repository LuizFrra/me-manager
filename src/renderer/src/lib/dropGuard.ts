const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

/**
 * Files dragged in from the desktop and dropped where nothing takes them (anywhere but the terminal) are refused.
 * Chromium would otherwise open the file in the window, replacing the app with it, and main's will-navigate guard
 * never sees that navigation. Places that take files call preventDefault on dragover themselves, before this
 * listener on the window runs, and keep their drop effect.
 */
export function refuseStrayFileDrops(win: Window): () => void {
  const onDragOver = (e: DragEvent): void => {
    if (!carriesFiles(e) || e.defaultPrevented) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  }
  const onDrop = (e: DragEvent): void => {
    if (carriesFiles(e)) e.preventDefault()
  }
  win.addEventListener('dragover', onDragOver)
  win.addEventListener('drop', onDrop)
  return () => {
    win.removeEventListener('dragover', onDragOver)
    win.removeEventListener('drop', onDrop)
  }
}
