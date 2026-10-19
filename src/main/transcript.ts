import { join } from 'node:path'
import type { SavedTranscript, Target } from '../shared/types'
import type { CapturedTranscript } from './contracts'

/** The longest tab name kept in a transcript's file name. */
const MAX_TAB_IN_NAME = 40

/** `name` as part of a file name: letters, digits, `.`, `_` and `-` only, never leading dots or dashes. */
const fileWord = (name: string): string =>
  name
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+|-+$/g, '')
    .slice(0, MAX_TAB_IN_NAME)
    .replace(/-+$/, '')

const pad = (n: number): string => String(n).padStart(2, '0')

/** `<theme>-<task or folder>-<tab>-<YYYYMMDD-HHMM>.txt`, in local time. The theme and target are slugs. */
export function transcriptFileName(names: { theme: string; target: string; tab: string }, at: Date): string {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${[fileWord(names.theme), fileWord(names.target), fileWord(names.tab) || 'tab', day, time].join('-')}.txt`
}

/** What saveTranscript needs; main/ipc.ts passes Electron's save dialog, tests a fake. */
export interface TranscriptSaveDeps {
  capture(target: Target, index: number): Promise<CapturedTranscript>
  /** Asks where to save, suggesting `defaultPath`; null when the user cancels. */
  askSavePath(defaultPath: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
  /** The folder the suggested file is in. */
  downloadsDir(): string
}

/**
 * MeManagerApi.saveTranscript. The tab is captured first, so the file holds what the tab showed when the user asked
 * (not when they closed the dialog), and a gone tab is reported without a dialog.
 */
export async function saveTranscript(
  deps: TranscriptSaveDeps,
  target: Target,
  index: number,
): Promise<SavedTranscript | null> {
  const { transcript, fileName } = await deps.capture(target, index)
  const path = await deps.askSavePath(join(deps.downloadsDir(), fileName))
  if (path === null) return null
  try {
    await deps.writeFile(path, transcript.text)
  } catch (err) {
    throw new Error(`Could not save ${path}: ${err instanceof Error ? err.message : err}`, { cause: err })
  }
  return { path, lines: transcript.lines, truncated: transcript.truncated }
}
