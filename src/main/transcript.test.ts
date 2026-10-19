import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Target } from '../shared/types'
import type { CapturedTranscript } from './contracts'
import { saveTranscript, transcriptFileName, type TranscriptSaveDeps } from './transcript'

describe('transcriptFileName', () => {
  const at = new Date(2026, 0, 2, 3, 4, 59) // local time

  it('joins the theme, the task or folder, the tab and the local time', () => {
    expect(transcriptFileName({ theme: 'client-x', target: 'fix-login', tab: 'claude' }, at)).toBe(
      'client-x-fix-login-claude-20260102-0304.txt',
    )
  })

  it('keeps only safe characters of a tab name, and never an empty or hidden name', () => {
    const name = (tab: string): string => transcriptFileName({ theme: 't', target: 'x', tab }, at)
    expect(name('shell 2')).toBe('t-x-shell-2-20260102-0304.txt')
    expect(name('../../etc/passwd')).toBe('t-x-etc-passwd-20260102-0304.txt')
    expect(name('café: ☕ #1')).toBe('t-x-café-1-20260102-0304.txt')
    expect(name('///')).toBe('t-x-tab-20260102-0304.txt')
    expect(name('a'.repeat(200))).toBe(`t-x-${'a'.repeat(40)}-20260102-0304.txt`)
  })
})

describe('saveTranscript', () => {
  const target: Target = { themeId: 'th', itemId: 'it', taskId: 'ta' }
  const captured: CapturedTranscript = {
    transcript: { text: 'one\ntwo\n', lines: 2, truncated: false },
    fileName: 'client-x-fix-claude-20261018-0905.txt',
  }
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-transcript-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const deps = (overrides: Partial<TranscriptSaveDeps> = {}): TranscriptSaveDeps => ({
    capture: vi.fn(async () => captured),
    askSavePath: vi.fn(async (defaultPath: string) => join(dir, `chosen-${defaultPath.split('/').pop()}`)),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    downloadsDir: () => '/home/me/Downloads',
    ...overrides,
  })

  it('suggests the file name in Downloads, writes the transcript where the user chose, and returns that path', async () => {
    const d = deps()
    const saved = await saveTranscript(d, target, 1)
    expect(d.capture).toHaveBeenCalledWith(target, 1)
    expect(d.askSavePath).toHaveBeenCalledWith('/home/me/Downloads/client-x-fix-claude-20261018-0905.txt')
    const path = join(dir, 'chosen-client-x-fix-claude-20261018-0905.txt')
    expect(saved).toEqual({ path, lines: 2, truncated: false })
    await expect(readFile(path, 'utf8')).resolves.toBe('one\ntwo\n')
  })

  it('passes on that the transcript was cut', async () => {
    const d = deps({ capture: async () => ({ ...captured, transcript: { ...captured.transcript, truncated: true } }) })
    await expect(saveTranscript(d, target, 0)).resolves.toMatchObject({ truncated: true })
  })

  it('writes nothing and returns null when the dialog is cancelled', async () => {
    const write = vi.fn(async () => {})
    await expect(saveTranscript(deps({ askSavePath: async () => null, writeFile: write }), target, 0)).resolves.toBe(
      null,
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('never opens the dialog when the capture fails', async () => {
    const d = deps({ capture: async () => Promise.reject(new Error('That tab is no longer open')) })
    await expect(saveTranscript(d, target, 3)).rejects.toThrow('That tab is no longer open')
    expect(d.askSavePath).not.toHaveBeenCalled()
  })

  it('rejects when the file cannot be written', async () => {
    const d = deps({ askSavePath: async () => join(dir, 'missing-folder', 'x.txt') })
    await expect(saveTranscript(d, target, 0)).rejects.toThrow(/^Could not save .*x\.txt: ENOENT/)
  })
})
