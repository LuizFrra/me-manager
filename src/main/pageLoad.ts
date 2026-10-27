/**
 * Loads the window's page. A failed load (the renderer bundle missing, the dev server down) would otherwise be an
 * unhandled rejection and a window that never shows, as it waits for ready-to-show: it is logged and `failed` is
 * called with why. A load cut short by another one (ERR_ABORTED, a reload) is not a failure.
 */
export async function loadPage(load: () => Promise<void>, failed: (message: string) => void): Promise<void> {
  try {
    await load()
  } catch (err) {
    if ((err as { code?: unknown })?.code === 'ERR_ABORTED') return
    console.error(err)
    failed(err instanceof Error ? err.message : String(err))
  }
}
