import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FONT_SIZE_LIMITS } from '../../../shared/settings'
import { MAX_TASK_TEMPLATES, type TemplateErrors } from '../../../shared/templates'
import { MAX_TASK_PROMPT, type Settings, type UpdateStrategy } from '../../../shared/types'
import {
  newTemplateKey,
  parseForm,
  POLL_SECONDS,
  toForm,
  type EditableSettings,
  type SettingsForm,
  type TemplateForm,
} from '../lib/settingsForm'
import { useRestoreFocus } from '../lib/useRestoreFocus'

/**
 * A labelled field with an optional hint and warning, and its validation message (which also marks the input
 * invalid).
 */
function Field(props: {
  label: string
  hint?: string
  error?: string
  /** Shown under the field, e.g. what it can't edit; it doesn't stop saving. */
  warning?: string
  suffix?: string
  children: (aria: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => React.ReactNode
}): React.JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const warningId = `${id}-warning`
  const describedBy =
    [props.error && errorId, props.warning && warningId, props.hint && hintId].filter(Boolean).join(' ') || undefined
  return (
    <div className="settings-field">
      <label htmlFor={id}>{props.label}</label>
      <div className="settings-input">
        {props.children({ id, 'aria-invalid': Boolean(props.error), 'aria-describedby': describedBy })}
        {props.suffix && <span className="settings-suffix">{props.suffix}</span>}
      </div>
      {props.error && (
        <p id={errorId} className="settings-error">
          {props.error}
        </p>
      )}
      {props.warning && (
        <p id={warningId} className="settings-warning">
          {props.warning}
        </p>
      )}
      {props.hint && (
        <p id={hintId} className="settings-hint">
          {props.hint}
        </p>
      )}
    </div>
  )
}

/** What gets focus once the template list has re-rendered: a control of one template, or the Add button. */
type TemplateFocus = { key: string; control: 'name' | 'up' | 'down' | 'delete' } | 'add'

/**
 * The "Task templates" section: one group of fields per template, with buttons to move it up or down and to
 * delete it, and one to add a template at the end. After each of those, focus lands on the control that took the
 * place of the one pressed, so the keyboard user stays in the list.
 */
function TaskTemplatesSection(props: {
  templates: TemplateForm[]
  errors?: TemplateErrors[]
  onChange: (update: (templates: TemplateForm[]) => TemplateForm[]) => void
}): React.JSX.Element {
  const { templates, errors, onChange } = props
  // Set by the buttons, and applied once the list they changed has rendered.
  const pendingFocus = useRef<TemplateFocus | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const introId = useId()
  const limitId = useId()
  const full = templates.length >= MAX_TASK_TEMPLATES

  useEffect(() => {
    const focus = pendingFocus.current
    if (!focus) return
    pendingFocus.current = null
    const root = sectionRef.current
    if (focus === 'add') return root?.querySelector<HTMLElement>('[data-control="add"]')?.focus()
    const control = (name: string): HTMLButtonElement | HTMLInputElement | null | undefined =>
      root?.querySelector(`[data-template="${focus.key}"] [data-control="${name}"]`)
    // A move to the top or the bottom turns the button pressed off: the other one takes the focus.
    const other = focus.control === 'up' ? 'down' : focus.control === 'down' ? 'up' : focus.control
    const target = [control(focus.control), control(other)].find((el) => el && !el.disabled)
    target?.focus()
  }, [templates])

  const edit = (key: string, field: keyof Omit<TemplateForm, 'key'>, value: string): void =>
    onChange((list) => list.map((t) => (t.key === key ? { ...t, [field]: value } : t)))
  const move = (index: number, step: -1 | 1): void => {
    onChange((list) => {
      const next = [...list]
      ;[next[index], next[index + step]] = [next[index + step], next[index]]
      return next
    })
    pendingFocus.current = { key: templates[index].key, control: step < 0 ? 'up' : 'down' }
  }
  const remove = (index: number): void => {
    onChange((list) => list.filter((_, i) => i !== index))
    const after = templates[index + 1] ?? templates[index - 1]
    pendingFocus.current = after ? { key: after.key, control: 'delete' } : 'add'
  }
  const add = (): void => {
    const key = newTemplateKey()
    onChange((list) => [...list, { key, name: '', taskName: '', base: '', prompt: '' }])
    pendingFocus.current = { key, control: 'name' }
  }

  return (
    <section className="settings-section" aria-label="Task templates" ref={sectionRef}>
      <h3>Task templates</h3>
      <p id={introId} className="settings-hint">
        Presets for the New task dialog, which fills in its fields from the one you pick; they stay editable. In a task
        name, <code>{'{date}'}</code> is today as YYYYMMDD and <code>{'{n}'}</code> the next number not used by the
        repository&apos;s tasks, archived ones included. A base branch the repository doesn&apos;t have gives its
        default branch instead.
      </p>
      {templates.length > 0 && (
        <ol className="template-list">
          {templates.map((t, i) => {
            const label = t.name.trim() || String(i + 1)
            const e = errors?.[i] ?? {}
            return (
              <li key={t.key} data-template={t.key}>
                <fieldset className="template-card" aria-label={`Template ${label}`}>
                  <div className="settings-row">
                    <Field label="Name" error={e.name}>
                      {(aria) => (
                        <input
                          {...aria}
                          data-control="name"
                          placeholder="e.g. Review"
                          value={t.name}
                          onChange={(ev) => edit(t.key, 'name', ev.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="Task name" error={e.taskName}>
                      {(aria) => (
                        <input
                          {...aria}
                          className="mono"
                          spellCheck={false}
                          placeholder="e.g. review-{n}"
                          value={t.taskName}
                          onChange={(ev) => edit(t.key, 'taskName', ev.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                  <Field label="Base branch" error={e.base}>
                    {(aria) => (
                      <input
                        {...aria}
                        className="mono"
                        spellCheck={false}
                        placeholder="The repository's default"
                        value={t.base}
                        onChange={(ev) => edit(t.key, 'base', ev.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Initial prompt" error={e.prompt}>
                    {(aria) => (
                      <textarea
                        {...aria}
                        rows={3}
                        maxLength={MAX_TASK_PROMPT}
                        placeholder="What should Claude start with?"
                        value={t.prompt}
                        onChange={(ev) => edit(t.key, 'prompt', ev.target.value)}
                      />
                    )}
                  </Field>
                  <div className="template-actions">
                    <button
                      type="button"
                      data-control="up"
                      aria-label={`Move template ${label} up`}
                      title="Move up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      data-control="down"
                      aria-label={`Move template ${label} down`}
                      title="Move down"
                      disabled={i === templates.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      data-control="delete"
                      aria-label={`Delete template ${label}`}
                      onClick={() => remove(i)}
                    >
                      Delete
                    </button>
                  </div>
                </fieldset>
              </li>
            )
          })}
        </ol>
      )}
      <div className="template-add">
        <button
          type="button"
          data-control="add"
          disabled={full}
          aria-describedby={full ? limitId : undefined}
          onClick={add}
        >
          Add template
        </button>
        {full && (
          <span id={limitId} className="settings-hint">
            At most {MAX_TASK_TEMPLATES} templates.
          </span>
        )}
      </div>
    </section>
  )
}

const UPDATE_CHOICES: { value: UpdateStrategy; label: string; hint: string }[] = [
  { value: 'rebase', label: 'Rebase', hint: 'replays the task’s commits on top of the base (git rebase)' },
  { value: 'merge', label: 'Merge', hint: 'adds a merge commit (git merge --no-edit)' },
]

/** Edits the app settings. Fields are checked as you type; Save is off while one is invalid. Esc cancels. */
export function SettingsDialog(props: {
  settings: Settings
  /** The edited settings, a patch over the current ones. */
  onSave: (settings: EditableSettings) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<SettingsForm>(() => toForm(props.settings))
  // A one-line input can't show (or keep) a line break: such arguments are only saved back as they were, unless
  // the field is edited, and a warning points to settings.json.
  const [argsEdited, setArgsEdited] = useState(false)
  const multilineArg = props.settings.claudeArgs.some((arg) => /[\r\n]/.test(arg))
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const parsed = useMemo(() => {
    const result = parseForm(form)
    if (!result.settings || argsEdited || !multilineArg) return result
    return { settings: { ...result.settings, claudeArgs: [...props.settings.claudeArgs] } }
  }, [form, argsEdited, multilineArg, props.settings.claudeArgs])
  const errors = parsed.errors ?? {}
  const notificationsHintId = useId()
  const statusBarHintId = useId()
  const remoteHintId = useId()
  const skipHintId = useId()
  const strategyHintId = useId()
  useRestoreFocus()

  const set =
    (
      field: Exclude<
        keyof SettingsForm,
        'notifications' | 'remoteControl' | 'skipPermissions' | 'updateStrategy' | 'showStatusBar' | 'taskTemplates'
      >,
    ) =>
    (e: React.ChangeEvent<HTMLInputElement>): void =>
      setForm((f) => ({ ...f, [field]: e.target.value }))

  const save = async (): Promise<void> => {
    if (busyRef.current || !parsed.settings) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onSave(parsed.settings)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <form
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          props.onCancel()
        }}
      >
        <h2>Settings</h2>

        <section className="settings-section" aria-label="Claude">
          <h3>Claude</h3>
          <Field
            label="Extra claude arguments"
            hint="Added to every claude the app starts. Quote values with spaces, as in a shell."
            error={errors.claudeArgs}
            warning={
              !multilineArg
                ? undefined
                : argsEdited
                  ? 'An argument had a line break, which this field drops: saving now saves it without. Edit settings.json to change this argument and keep it.'
                  : 'An argument contains a line break, which this field can’t show. Edit settings.json to change this argument; saving here keeps it as it is.'
            }
          >
            {(aria) => (
              <input
                {...aria}
                autoFocus
                className="mono"
                spellCheck={false}
                placeholder="e.g. --model opus"
                value={form.claudeArgs}
                onChange={(e) => {
                  setArgsEdited(true)
                  set('claudeArgs')(e)
                }}
              />
            )}
          </Field>
          <div className="settings-field">
            <label className="checkbox">
              <input
                type="checkbox"
                aria-describedby={remoteHintId}
                checked={form.remoteControl}
                onChange={(e) => setForm((f) => ({ ...f, remoteControl: e.target.checked }))}
              />
              Remote Control
            </label>
            <p id={remoteHintId} className="settings-hint settings-checkbox-hint">
              Starts claude with <code>--remote-control</code>, named after the task (theme/repo/task), so you can
              follow and steer it from claude.ai or the Claude app.
            </p>
          </div>
          <div className="settings-field">
            <label className="checkbox">
              <input
                type="checkbox"
                aria-describedby={skipHintId}
                checked={form.skipPermissions}
                onChange={(e) => setForm((f) => ({ ...f, skipPermissions: e.target.checked }))}
              />
              Skip permission prompts
            </label>
            <p id={skipHintId} className="settings-hint settings-checkbox-hint">
              Starts claude with <code>--dangerously-skip-permissions</code>.
            </p>
            {form.skipPermissions && (
              <p role="alert" className="settings-warning">
                Claude will run any command and edit any file without asking — including outside the task&apos;s
                worktree. The worktree keeps edits off your main checkout, but it is not a sandbox.
              </p>
            )}
          </div>
          <p className="settings-note">
            Applies to sessions started after saving; running sessions keep the arguments they started with.
          </p>
        </section>

        <section className="settings-section" aria-label="Editor">
          <h3>Editor</h3>
          <Field
            label="Editor command"
            hint="A GUI editor; the task's folder is added at the end. Leave empty to use code, cursor, $VISUAL or $EDITOR."
            error={errors.editorCommand}
          >
            {(aria) => (
              <input
                {...aria}
                className="mono"
                spellCheck={false}
                placeholder="Auto-detect"
                value={form.editorCommand}
                onChange={set('editorCommand')}
              />
            )}
          </Field>
        </section>

        <section className="settings-section" aria-label="Git">
          <h3>Git</h3>
          <fieldset className="settings-choice" aria-describedby={strategyHintId}>
            <legend>Update from base</legend>
            {UPDATE_CHOICES.map(({ value, label, hint }) => (
              <label key={value} className="settings-choice-option">
                <input
                  type="radio"
                  name="updateStrategy"
                  value={value}
                  checked={form.updateStrategy === value}
                  onChange={() => setForm((f) => ({ ...f, updateStrategy: value }))}
                />
                <span>
                  {label} <span className="settings-choice-hint">{hint}</span>
                </span>
              </label>
            ))}
            <p id={strategyHintId} className="settings-hint">
              How a task gets its base branch&apos;s new commits. Either way, a conflict is undone and reported.
            </p>
          </fieldset>
        </section>

        <section className="settings-section" aria-label="Interface">
          <h3>Interface</h3>
          <div className="settings-row">
            <Field
              label="Refresh interval"
              hint={`Status and files panel, ${POLL_SECONDS.min}–${POLL_SECONDS.max} s.`}
              error={errors.pollSeconds}
              suffix="s"
            >
              {(aria) => (
                <input
                  {...aria}
                  type="number"
                  inputMode="decimal"
                  min={POLL_SECONDS.min}
                  max={POLL_SECONDS.max}
                  step={0.5}
                  value={form.pollSeconds}
                  onChange={set('pollSeconds')}
                />
              )}
            </Field>
            <Field
              label="Terminal font size"
              hint={`${FONT_SIZE_LIMITS.min}–${FONT_SIZE_LIMITS.max} px.`}
              error={errors.terminalFontSize}
              suffix="px"
            >
              {(aria) => (
                <input
                  {...aria}
                  type="number"
                  inputMode="numeric"
                  min={FONT_SIZE_LIMITS.min}
                  max={FONT_SIZE_LIMITS.max}
                  step={1}
                  value={form.terminalFontSize}
                  onChange={set('terminalFontSize')}
                />
              )}
            </Field>
          </div>
          <div className="settings-field">
            <label className="checkbox">
              <input
                type="checkbox"
                aria-describedby={notificationsHintId}
                checked={form.notifications}
                onChange={(e) => setForm((f) => ({ ...f, notifications: e.target.checked }))}
              />
              Desktop notifications
            </label>
            <p id={notificationsHintId} className="settings-hint settings-checkbox-hint">
              When Claude finishes or needs your input in a task or folder you aren&apos;t looking at.
            </p>
          </div>
          <div className="settings-field">
            <label className="checkbox">
              <input
                type="checkbox"
                aria-describedby={statusBarHintId}
                checked={form.showStatusBar}
                onChange={(e) => setForm((f) => ({ ...f, showStatusBar: e.target.checked }))}
              />
              Status bar
            </label>
            <p id={statusBarHintId} className="settings-hint settings-checkbox-hint">
              A thin bar under the terminal: branch, commits ahead/behind, changes, Claude&apos;s state and today&apos;s
              cost.
            </p>
          </div>
        </section>

        <TaskTemplatesSection
          templates={form.taskTemplates}
          errors={errors.taskTemplates}
          onChange={(update) => setForm((f) => ({ ...f, taskTemplates: update(f.taskTemplates) }))}
        />

        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !parsed.settings}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
