import { budgetFromText, budgetText } from '../../../shared/budget'
import { FONT_SIZE_LIMITS, POLL_INTERVAL_LIMITS } from '../../../shared/settings'
import { commandBasename, isTerminalEditor } from '../../../shared/editor'
import { joinShellWords, splitShellWords } from '../../../shared/shell'
import { templateListErrors, toTaskTemplate, type TemplateErrors, type TemplateFields } from '../../../shared/templates'
import type { Appearance, Settings, TaskTemplate, UpdateStrategy } from '../../../shared/types'

/** A task template as edited: its fields as typed, and a key that stays with it while the list is reordered. */
export interface TemplateForm extends TemplateFields {
  key: string
}

let templateKeys = 0
/** A key no other template in the form has. */
export const newTemplateKey = (): string => `template-${++templateKeys}`

export const toTemplateForm = (t: TaskTemplate): TemplateForm => ({
  key: newTemplateKey(),
  name: t.name,
  taskName: t.taskName ?? '',
  base: t.base ?? '',
  prompt: t.prompt ?? '',
})

/** The Settings dialog's fields, as typed. The poll interval is edited in seconds, budgets in dollars ('' for none). */
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
  taskTemplates: TemplateForm[]
  dailyBudget: string
  taskBudget: string
  appearance: Appearance
}

/** What the Settings dialog edits: everything but what the app remembers by itself (the last clone folder). */
export type EditableSettings = Omit<Settings, 'cloneDirectory'>

export type SettingsFormErrors = Partial<Record<Exclude<keyof SettingsForm, 'taskTemplates'>, string>> & {
  /** Each template's errors, in order ({} for a valid one); absent when every template is valid. */
  taskTemplates?: TemplateErrors[]
}

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
    taskTemplates: s.taskTemplates.map(toTemplateForm),
    dailyBudget: budgetText(s.dailyBudgetUsd),
    taskBudget: budgetText(s.taskBudgetUsd),
    appearance: s.appearance,
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
  const budget = (field: 'dailyBudget' | 'taskBudget'): number | null => {
    const parsed = budgetFromText(form[field])
    if ('error' in parsed) errors[field] = parsed.error
    return 'value' in parsed ? parsed.value : null
  }
  const dailyBudgetUsd = budget('dailyBudget')
  const taskBudgetUsd = budget('taskBudget')
  const templateErrors = templateListErrors(form.taskTemplates)
  if (templateErrors.some((e) => Object.keys(e).length > 0)) errors.taskTemplates = templateErrors
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
      taskTemplates: form.taskTemplates.map(toTaskTemplate),
      dailyBudgetUsd,
      taskBudgetUsd,
      appearance: form.appearance,
    },
  }
}
