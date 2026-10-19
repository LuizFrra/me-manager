import { slugify } from './naming'
import { MAX_TASK_PROMPT, type BranchList, type TaskTemplate } from './types'

/** Task templates kept at most; normalizeTaskTemplates drops the rest. */
export const MAX_TASK_TEMPLATES = 50
export const MAX_TEMPLATE_NAME = 60
export const MAX_TASK_NAME_PATTERN = 100
const MAX_BASE = 200

/**
 * The task name pattern language, kept tiny: `{date}` is the local date as YYYYMMDD and `{n}` a number, the next
 * one after the highest the repo's tasks (archived ones included) already use with this pattern. Everything else
 * is literal text. Any other `{word}` is refused, as it is most likely a typo.
 */
const PLACEHOLDERS = ['{date}', '{n}'] as const
const TOKEN = /(\{date\}|\{n\})/
const WORD_IN_BRACES = /\{(\w+)\}/g

/** A template's fields as typed in Settings: every field a string, '' when not set. */
export interface TemplateFields {
  name: string
  taskName: string
  base: string
  prompt: string
}

export type TemplateErrors = Partial<Record<keyof TemplateFields, string>>

/** Template names are unique ignoring case (and surrounding spaces), like task and theme names. */
export const sameTemplateName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

const yyyymmdd = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The task name `pattern` gives at `now` (trimmed), for a repo whose tasks are named `existingNames` (archived ones
 * included). `{n}` is one more than the highest number used by a name the pattern could have given (ignoring case;
 * with `{date}` too, that day's names only), then the next one whose name or slug no task has. Gaps aren't reused:
 * a removed task's branch may still exist. Without `{n}` the result may be taken: creating the task then says so.
 */
export function expandTaskName(pattern: string, existingNames: readonly string[], now: Date): string {
  const date = yyyymmdd(now)
  const parts = pattern.trim().split(TOKEN)
  const render = (n: number): string => parts.map((p) => (p === '{date}' ? date : p === '{n}' ? String(n) : p)).join('')
  if (!parts.includes('{n}')) return render(0)

  const shape = new RegExp(
    `^${parts.map((p) => (p === '{date}' ? date : p === '{n}' ? '(\\d+)' : escapeRegExp(p))).join('')}$`,
    'i',
  )
  let highest = 0
  for (const name of existingNames) {
    const n = Number(shape.exec(name.trim())?.[1])
    if (Number.isSafeInteger(n)) highest = Math.max(highest, n)
  }
  const names = new Set(existingNames.map((name) => name.trim().toLowerCase()))
  const slugs = new Set(existingNames.map(slugify))
  let n = highest + 1
  while (names.has(render(n).toLowerCase()) || slugs.has(slugify(render(n)))) n++
  return render(n)
}

const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

function taskNameError(pattern: string): string | undefined {
  if (pattern === '') return undefined
  if (pattern.length > MAX_TASK_NAME_PATTERN) return `Use at most ${MAX_TASK_NAME_PATTERN} characters.`
  if (hasControl(pattern)) return 'No tabs, line breaks or other control characters.'
  for (const [placeholder] of pattern.matchAll(WORD_IN_BRACES)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(placeholder))
      return `Unknown placeholder ${placeholder}: use {date} or {n}.`
  }
  if (!slugify(expandTaskName(pattern, [], new Date()))) return 'The name needs letters or numbers.'
  return undefined
}

/** What is wrong with a template's name (trimmed first), if anything. */
export function templateNameError(raw: string): string | undefined {
  const name = raw.trim()
  if (!name) return 'Enter a name.'
  if (name.length > MAX_TEMPLATE_NAME) return `Use at most ${MAX_TEMPLATE_NAME} characters.`
  if (hasControl(name)) return 'No tabs, line breaks or other control characters.'
  return undefined
}

/**
 * What is wrong with each field of one template (trimmed first); {} when it can be saved. A base is only checked
 * to look like a branch name here: whether a repo has it is up to the New task dialog (see templateBase).
 */
export function templateErrors(fields: TemplateFields): TemplateErrors {
  const errors: TemplateErrors = {}
  const name = templateNameError(fields.name)
  if (name) errors.name = name
  const taskName = taskNameError(fields.taskName.trim())
  if (taskName) errors.taskName = taskName
  const base = fields.base.trim()
  if (base && (base.length > MAX_BASE || base.startsWith('-') || /\s/.test(base) || hasControl(base)))
    errors.base = 'Enter a branch name, e.g. origin/main.'
  if (fields.prompt.trim().length > MAX_TASK_PROMPT || fields.prompt.includes('\0'))
    errors.prompt = `Use at most ${MAX_TASK_PROMPT} characters.`
  return errors
}

/** templateErrors for each template of a list, plus a name already used by an earlier one. */
export function templateListErrors(list: readonly TemplateFields[]): TemplateErrors[] {
  return list.map((fields, i) => {
    const errors = templateErrors(fields)
    if (!errors.name && list.slice(0, i).some((other) => sameTemplateName(other.name, fields.name)))
      errors.name = 'Another template has this name.'
    return errors
  })
}

/** The template the (valid) fields describe: trimmed, empty fields left out. */
export function toTaskTemplate(fields: TemplateFields): TaskTemplate {
  const template: TaskTemplate = { name: fields.name.trim() }
  for (const key of ['taskName', 'base', 'prompt'] as const) {
    const value = fields[key].trim()
    if (value) template[key] = value
  }
  return template
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Turns anything (settings.json's `taskTemplates`, a renderer's patch) into valid templates: entries that aren't
 * templates or have an invalid field are dropped, as is a template named like an earlier one, and at most
 * MAX_TASK_TEMPLATES are kept. A missing or null optional field is fine; a wrongly typed one drops the entry.
 */
export function normalizeTaskTemplates(raw: unknown): TaskTemplate[] {
  if (!Array.isArray(raw)) return []
  const kept: TaskTemplate[] = []
  for (const entry of raw) {
    if (kept.length === MAX_TASK_TEMPLATES) break
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    const text = (v: unknown): string | null => (v === undefined || v === null ? '' : typeof v === 'string' ? v : null)
    const [taskName, base, prompt] = [text(entry.taskName), text(entry.base), text(entry.prompt)]
    if (taskName === null || base === null || prompt === null) continue
    const fields: TemplateFields = { name: entry.name, taskName, base, prompt }
    if (Object.keys(templateErrors(fields)).length > 0) continue
    if (kept.some((t) => sameTemplateName(t.name, fields.name))) continue
    kept.push(toTaskTemplate(fields))
  }
  return kept
}

/**
 * The base a task from a template with `base` starts from in a repo with these branches: `base` itself when it is
 * listed, else `origin/<base>` when that is (so a global template can say `develop`), else the repo's default,
 * with `missing` set so the dialog can say so. Falling back rather than refusing keeps templates usable across
 * repos that don't all have the branch; the dialog shows the fallback before anything is created.
 */
export function templateBase(base: string | undefined, list: BranchList): { baseRef: string; missing?: string } {
  if (!base) return { baseRef: list.default }
  if (list.branches.includes(base)) return { baseRef: base }
  if (list.branches.includes(`origin/${base}`)) return { baseRef: `origin/${base}` }
  return { baseRef: list.default, missing: base }
}
