import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPage } from './pageLoad'

/** An error as Electron's loadURL / loadFile reject with: a Chromium net error code. */
const loadError = (code: string): Error => Object.assign(new Error(`${code} (-6) loading 'file:///x'`), { code })

describe('loadPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does nothing more when the page loads', async () => {
    const failed = vi.fn()
    await loadPage(async () => {}, failed)
    expect(failed).not.toHaveBeenCalled()
  })

  it('logs and reports a failed load instead of leaving the rejection unhandled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = vi.fn()
    const err = loadError('ERR_FILE_NOT_FOUND')
    await expect(loadPage(() => Promise.reject(err), failed)).resolves.toBeUndefined()
    expect(failed).toHaveBeenCalledWith(err.message)
    expect(error).toHaveBeenCalledWith(err)
  })

  it('ignores a load cut short by another one (a reload)', async () => {
    const failed = vi.fn()
    await loadPage(() => Promise.reject(loadError('ERR_ABORTED')), failed)
    expect(failed).not.toHaveBeenCalled()
  })
})
