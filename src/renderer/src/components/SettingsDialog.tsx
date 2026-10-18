import { useId, useMemo, useRef, useState } from 'react'
import { FONT_SIZE_LIMITS } from '../../../shared/settings'
import type { Settings, UpdateStrategy } from '../../../shared/types'
import { parseForm, POLL_SECONDS, toForm, type EditableSettings, type SettingsForm } from '../lib/settingsForm'
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
        'notifications' | 'remoteControl' | 'skipPermissions' | 'updateStrategy' | 'showStatusBar'
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
