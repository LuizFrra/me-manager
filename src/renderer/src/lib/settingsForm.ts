import { FONT_SIZE_LIMITS, POLL_INTERVAL_LIMITS } from '../../../shared/settings'
import { commandBasename, isTerminalEditor } from '../../../shared/editor'
import { joinShellWords, splitShellWords } from '../../../shared/shell'
import type { Settings, UpdateStrategy } from '../../../shared/types'

/** The Settings dialog's fields, as typed. The poll interval is edited in seconds. */
export interface SettingsForm {
  claudeArgs: string
  editorCommand: string
  pollSeconds: string
  terminalFontSize: string
  notifications: boolean
  remoteControl: boolean
  skipPermissions: boolean
  updateStrategy: UpdateStrategy
  showStatusBar: boolean
}

/** What the Settings dialog edits: everything but what the app remembers by itself (the last clone folder). */
export type EditableSettings = Omit<Settings, 'cloneDirectory'>

export type SettingsFormErrors = Partial<Record<keyof SettingsForm, string>>

export const POLL_SECONDS = { min: POLL_INTERVAL_LIMITS.min / 1000, max: POLL_INTERVAL_LIMITS.max / 1000 }

export function toForm(s: Settings): SettingsForm {
  return {
    claudeArgs: joinShellWords(s.claudeArgs),
    editorCommand: s.editorCommand,
    pollSeconds: String(s.pollIntervalMs / 1000),
    terminalFontSize: String(s.terminalFontSize),
    notifications: s.notifications,
    remoteControl: s.remoteControl,
    skipPermissions: s.skipPermissions,
    updateStrategy: s.updateStrategy,
    showStatusBar: s.showStatusBar,
  }
}

const numberIn = (text: string, { min, max }: { min: number; max: number }): number | null => {
  const n = text.trim() === '' ? NaN : Number(text)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

/** The form as Settings, or the message to show under each invalid field. */
export function parseForm(
  form: SettingsForm,
): { settings: EditableSettings; errors?: undefined } | { settings?: undefined; errors: SettingsFormErrors } {
  const errors: SettingsFormErrors = {}
  const words = (field: 'claudeArgs' | 'editorCommand'): string[] => {
    try {
      return splitShellWords(form[field])
    } catch (err) {
      errors[field] = `${(err as Error).message}.`
      return []
    }
  }
  const claudeArgs = words('claudeArgs')
  const editor = words('editorCommand')
  if (isTerminalEditor(editor))
    errors.editorCommand = `${commandBasename(editor[0])} runs in a terminal; choose a GUI editor (e.g. code, subl, gvim).`
  const poll = numberIn(form.pollSeconds, POLL_SECONDS)
  if (poll === null) errors.pollSeconds = `Enter a number of seconds from ${POLL_SECONDS.min} to ${POLL_SECONDS.max}.`
  const fontSize = numberIn(form.terminalFontSize, FONT_SIZE_LIMITS)
  if (fontSize === null || !Number.isInteger(fontSize))
    errors.terminalFontSize = `Enter a whole number from ${FONT_SIZE_LIMITS.min} to ${FONT_SIZE_LIMITS.max}.`
  if (Object.keys(errors).length > 0) return { errors }
  return {
    settings: {
      claudeArgs,
      editorCommand: form.editorCommand.trim(),
      pollIntervalMs: Math.round(poll! * 1000),
      terminalFontSize: fontSize!,
      notifications: form.notifications,
      remoteControl: form.remoteControl,
      skipPermissions: form.skipPermissions,
      updateStrategy: form.updateStrategy,
      showStatusBar: form.showStatusBar,
    },
  }
}
