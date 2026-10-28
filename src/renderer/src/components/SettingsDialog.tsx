import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FONT_SIZE_LIMITS } from '../../../shared/settings'
import { MAX_TASK_TEMPLATES, type TemplateErrors } from '../../../shared/templates'
import {
  MAX_TASK_PROMPT,
  PROFILE_BILLINGS,
  type Appearance,
  type ClaudeProfile,
  type MeManagerApi,
  type ProfileBilling,
  type ProfileLogin,
  type ProfileStatus,
  type Settings,
  type TabInfo,
  type Target,
  type TerminalMode,
  type UpdateStrategy,
} from '../../../shared/types'
import { slugify } from '../../../shared/naming'
import { profileError } from '../../../shared/profiles'
import { plural } from '../lib/gitStatus'
import { BILLING_LABEL, LOGIN_TEXT } from '../lib/profiles'
import { cleanError } from '../lib/toasts'
import { useLatestCallback } from '../lib/useLatestCallback'
import {
  errorCount,
  formChanged,
  newTemplateKey,
  parseForm,
  POLL_SECONDS,
  toForm,
  type EditableSettings,
  type SettingsForm,
  type TemplateForm,
} from '../lib/settingsForm'
import { useConfirmDiscard } from '../lib/useConfirmDiscard'
import { useRestoreFocus } from '../lib/useRestoreFocus'

/**
 * A number input the mouse wheel doesn't change. Chromium steps a focused number field's value on wheel, so
 * scrolling the dialog with the pointer over the field just edited would change it unseen; the wheel scrolls the
 * dialog (its form) instead. React's onWheel is passive and can't prevent that, hence the listener.
 */
function NumberInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const input = ref.current
    if (!input) return
    const onWheel = (e: WheelEvent): void => {
      if (document.activeElement !== input) return
      e.preventDefault()
      if (input.form) input.form.scrollTop += e.deltaY
    }
    input.addEventListener('wheel', onWheel, { passive: false })
    return () => input.removeEventListener('wheel', onWheel)
  }, [])
  return <input ref={ref} type="number" {...props} />
}

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

/** What the Claude accounts section calls; profile changes go straight to main, not through Save. */
export interface AccountsProps {
  api: Pick<MeManagerApi, 'listProfiles' | 'addProfile' | 'updateProfile' | 'removeProfile' | 'loginProfile'>
  /** Where Log in opens its tab: the selected task or folder, with its name; null when none is (or it's archived). */
  target: { target: Target; label: string } | null
  /** The profiles as main has them, once read and after each change. */
  onChange: (profiles: ProfileStatus[]) => void
  /** Log in opened its tab in `target`: the target's tabs, the login one active. */
  onLogin: (target: Target, tabs: TabInfo[]) => void
}

const LOGIN_TITLE: Record<ProfileLogin, string> = {
  signedIn: 'Its folder has a login (a credentials file)',
  keyOrGateway: 'Its settings.json sets an apiKeyHelper or ANTHROPIC_BASE_URL',
  notSignedIn: 'No login in its folder yet: Log in, then run /login in the tab it opens',
  unknown: 'On macOS Claude Code keeps the login in the Keychain, which the app doesn’t read',
  folderMissing: 'The folder was deleted or moved: its tasks and folders won’t start until it is back',
}

/** The folder a new account gets until one is typed: ~/.claude-<the name as a slug>. */
const suggestedFolder = (name: string): string => `~/.claude-${slugify(name) || 'account'}`

/**
 * profileError for a folder as typed: main expands a leading `~/` to the home folder, which the renderer doesn't
 * know, so such a folder is checked under a stand-in absolute one (main still refuses one another account has).
 */
const accountError = (name: string, folder: string, others: readonly ClaudeProfile[]): string | null => {
  const trimmed = folder.trim()
  return profileError({ name, configDir: trimmed.startsWith('~/') ? `/~${trimmed.slice(1)}` : trimmed }, others)
}

/** For an account's field: Enter runs `run` instead of the dialog's Save, Esc `cancel` instead of its Cancel. */
const ownKeys =
  (run: () => void, cancel: () => void) =>
  (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }

/** Runs one profile call; resolves to main's refusal, or null once the list it returned is shown. */
type Change = (op: () => Promise<ProfileStatus[]>) => Promise<string | null>

/** One account: name, login state, folder and billing, with Log in, and Rename and Remove for those added. */
function AccountRow(props: {
  api: AccountsProps['api']
  profile: ProfileStatus
  /** The other accounts, which its new name is checked against. */
  others: readonly ProfileStatus[]
  busy: boolean
  /** Log in is off without a target; `loginHintId` says why. */
  canLogin: boolean
  loginHintId: string
  change: Change
  onLogin: () => Promise<string | null>
  /** It was removed: its row, and the focus with it, is gone. */
  onRemoved: () => void
}): React.JSX.Element {
  const { api, profile: p, busy } = props
  // Main's last refusal (or a failed Log in), shown under the row until the next action.
  const [error, setError] = useState<string | null>(null)
  // The name being typed while renaming; null otherwise.
  const [renaming, setRenaming] = useState<string | null>(null)
  // Set when renaming ends: Rename, which the name field took the place of, gets the focus back.
  const refocus = useRef(false)
  const renameRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (renaming !== null || !refocus.current) return
    refocus.current = false
    renameRef.current?.focus()
  }, [renaming])
  const endRename = (): void => {
    refocus.current = true
    setRenaming(null)
  }
  // Remove asks first, in the row, what removing the account does; Cancel and Esc give the focus back to Remove.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const removeRef = useRef<HTMLButtonElement>(null)
  const refocusRemove = useRef(false)
  useEffect(() => {
    if (confirmingRemove || !refocusRemove.current) return
    refocusRemove.current = false
    removeRef.current?.focus() // enabled again by now
  }, [confirmingRemove])
  const cancelRemove = (): void => {
    refocusRemove.current = true
    setConfirmingRemove(false)
  }
  const remove = (): Promise<void> =>
    act(async () => {
      const refused = await props.change(() => api.removeProfile(p.id))
      if (refused) setConfirmingRemove(false)
      else props.onRemoved()
      return refused
    })
  const errorId = useId()
  const renameError = renaming === null ? null : accountError(renaming, p.configDir, props.others)
  const shown = renameError ?? error
  const act = async (op: () => Promise<string | null>): Promise<void> => {
    setError(null)
    setError(await op())
  }
  const rename = async (): Promise<void> => {
    if (renaming === null || renameError || busy) return
    if (renaming.trim() === p.name) return endRename()
    const refused = await props.change(() => api.updateProfile(p.id, { name: renaming }))
    setError(refused)
    if (!refused) endRename()
  }
  return (
    <li className="account-row" aria-label={p.name}>
      <div className="account-main">
        {renaming === null ? (
          <span className="account-name">{p.name}</span>
        ) : (
          <span className="settings-input account-rename">
            <input
              autoFocus
              aria-label={`New name for ${p.name}`}
              aria-invalid={shown ? true : undefined}
              aria-describedby={shown ? errorId : undefined}
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => ownKeys(() => void rename(), endRename)(e)}
            />
          </span>
        )}
        <span className={`account-login login-${p.login}`} title={LOGIN_TITLE[p.login]}>
          {LOGIN_TEXT[p.login]}
        </span>
      </div>
      <code className="account-folder" title={p.configDir}>
        {p.configDir}
      </code>
      <div className="account-actions">
        <select
          aria-label={`Billing for ${p.name}`}
          title="Estimated cost and budgets count only accounts you pay for; a company's shows its tokens"
          value={p.billing}
          disabled={busy}
          onChange={(e) => {
            const billing = e.target.value as ProfileBilling
            void act(() => props.change(() => api.updateProfile(p.id, { billing })))
          }}
        >
          {PROFILE_BILLINGS.map((b) => (
            <option key={b} value={b}>
              {BILLING_LABEL[b]}
            </option>
          ))}
        </select>
        <span className="account-buttons">
          {renaming === null ? (
            <>
              <button
                type="button"
                aria-label={`Log in to ${p.name}`}
                aria-describedby={props.canLogin ? undefined : props.loginHintId}
                title="Opens a “login” tab running claude in this account’s folder: run /login there"
                disabled={busy || !props.canLogin || p.login === 'folderMissing'}
                onClick={() => void act(props.onLogin)}
              >
                Log in
              </button>
              {!p.isDefault && (
                <>
                  <button
                    ref={renameRef}
                    type="button"
                    aria-label={`Rename ${p.name}`}
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      setRenaming(p.name)
                    }}
                  >
                    Rename
                  </button>
                  <button
                    ref={removeRef}
                    type="button"
                    aria-label={`Remove ${p.name}`}
                    title="Removes it from the app; its folder stays as it is"
                    disabled={busy || confirmingRemove}
                    onClick={() => {
                      setError(null)
                      setConfirmingRemove(true)
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button type="button" onClick={endRename}>
                Cancel
              </button>
              <button type="button" disabled={busy || renameError !== null} onClick={() => void rename()}>
                Save name
              </button>
            </>
          )}
        </span>
      </div>
      {confirmingRemove && (
        <div
          className="account-confirm"
          role="group"
          aria-label={`Remove ${p.name}?`}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            cancelRemove()
          }}
        >
          <p className="settings-hint">
            Its usage history leaves the usage totals and budgets, as its folder is no longer read. The folder itself
            stays as it is.
          </p>
          <span className="account-buttons">
            <button type="button" autoFocus onClick={cancelRemove}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Remove account
            </button>
          </span>
        </div>
      )}
      {shown && (
        <p id={errorId} className="settings-error" role="alert">
          {shown}
        </p>
      )}
    </li>
  )
}

/** The Add account form's fields; `folder` is null while it follows the name (suggestedFolder). */
interface NewAccount {
  name: string
  folder: string | null
  billing: ProfileBilling
}

/**
 * The "Claude accounts" section: one row per Claude profile, Default first, and a form to add one. Its changes are
 * made in main as they happen, apart from the dialog's Save and Cancel.
 */
function ClaudeAccountsSection({ api, target, ...props }: AccountsProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProfileStatus[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  // Where the last Log in opened its tab, to say what to do there.
  const [loginNote, setLoginNote] = useState<string | null>(null)
  const [adding, setAdding] = useState<NewAccount | null>(null)
  // Main's refusal of the last Add; the form's own errors are checked as it is typed.
  const [addRefused, setAddRefused] = useState<string | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const loginHintId = useId()
  const addErrorId = useId()
  const onChange = useLatestCallback(props.onChange)

  // Counts reads of the list and changes to it: a read answers only if nothing was read or changed since it began.
  const readSeq = useRef(0)

  // Read when shown, and again whenever the window gets the focus back: a /login run in a terminal meanwhile (the
  // app's or another) changes an account's login state. Not while a change is under way: it returns the list.
  useEffect(() => {
    let live = true
    const read = (): void => {
      if (busyRef.current) return
      const seq = ++readSeq.current
      const current = (): boolean => live && seq === readSeq.current
      api.listProfiles().then(
        (list) => {
          if (!current()) return
          setProfiles(list)
          setLoadError(null)
          onChange(list)
        },
        (err: unknown) => current() && setLoadError(cleanError(err)),
      )
    }
    read()
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [api, onChange])

  const change: Change = async (op) => {
    if (busyRef.current) return null
    readSeq.current++ // a read under way may predate the change
    busyRef.current = true
    setBusy(true)
    try {
      const list = await op()
      setProfiles(list)
      onChange(list)
      return null
    } catch (err) {
      return cleanError(err)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const login = async (profile: ProfileStatus): Promise<string | null> => {
    if (!target || busyRef.current) return null
    setLoginNote(null)
    try {
      props.onLogin(target.target, await api.loginProfile(profile.id, target.target))
      setLoginNote(`Opened a “login” tab in ${target.label}: close Settings and run /login there.`)
      return null
    } catch (err) {
      return cleanError(err)
    }
  }

  const folder = adding ? (adding.folder ?? suggestedFolder(adding.name)) : ''
  const addError = adding && profiles ? accountError(adding.name, folder, profiles) : null
  // "Enter a name" only once something was typed: the empty form is not an error yet.
  const shownAddError = adding && (adding.name || adding.folder !== null) ? (addError ?? addRefused) : addRefused
  const closeAdd = (): void => {
    setAdding(null)
    setAddRefused(null)
    requestAnimationFrame(() => addRef.current?.focus())
  }
  const add = async (): Promise<void> => {
    if (!adding || addError) return
    const refused = await change(() =>
      api.addProfile({ name: adding.name, configDir: folder, billing: adding.billing }),
    )
    setAddRefused(refused)
    if (!refused) closeAdd()
  }
  const edit = (patch: Partial<NewAccount>): void => {
    setAddRefused(null)
    setAdding((a) => (a ? { ...a, ...patch } : a))
  }
  const keys = (e: React.KeyboardEvent): void => ownKeys(() => void add(), closeAdd)(e)

  return (
    <section className="settings-section accounts-section" aria-label="Claude accounts">
      <h3>Claude accounts</h3>
      <p className="settings-hint">
        Each account is a Claude config folder, with its own login and settings.json (a company gateway, say). A theme
        or task picks one: the account button on a theme’s row, or “Claude account…” in a task’s menu. Changes here
        apply at once, not with Save; a running Claude keeps its account until it restarts.
      </p>
      {loadError && (
        <p className="settings-error" role="alert">
          Could not read the accounts: {loadError}
        </p>
      )}
      {profiles && (
        <ul className="account-list">
          {profiles.map((p) => (
            <AccountRow
              key={p.id}
              api={api}
              profile={p}
              others={profiles.filter((o) => o.id !== p.id)}
              busy={busy}
              canLogin={target !== null}
              loginHintId={loginHintId}
              change={change}
              onLogin={() => login(p)}
              onRemoved={() => requestAnimationFrame(() => addRef.current?.focus())}
            />
          ))}
        </ul>
      )}
      {!target && (
        <p id={loginHintId} className="settings-hint">
          Open a task or folder first: the login runs in its terminal.
        </p>
      )}
      {loginNote && (
        <p className="settings-hint" role="status">
          {loginNote}
        </p>
      )}
      {adding ? (
        <fieldset className="template-card account-add" aria-label="New account">
          <div className="settings-row">
            <Field label="Account name">
              {(aria) => (
                <input
                  {...aria}
                  autoFocus
                  placeholder="e.g. Work"
                  aria-invalid={Boolean(shownAddError)}
                  aria-describedby={shownAddError ? addErrorId : undefined}
                  value={adding.name}
                  onChange={(e) => edit({ name: e.target.value })}
                  onKeyDown={keys}
                />
              )}
            </Field>
            <Field label="Billing">
              {(aria) => (
                <select
                  {...aria}
                  value={adding.billing}
                  onChange={(e) => edit({ billing: e.target.value as ProfileBilling })}
                  onKeyDown={keys}
                >
                  {PROFILE_BILLINGS.map((b) => (
                    <option key={b} value={b}>
                      {BILLING_LABEL[b]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field label="Folder" hint="Created, empty, if it doesn’t exist. Removing the account later leaves it.">
            {(aria) => (
              <input
                {...aria}
                className="mono"
                spellCheck={false}
                value={folder}
                onChange={(e) => edit({ folder: e.target.value })}
                onKeyDown={keys}
              />
            )}
          </Field>
          {shownAddError && (
            <p id={addErrorId} className="settings-error" role="alert">
              {shownAddError}
            </p>
          )}
          <div className="template-actions">
            <button type="button" onClick={closeAdd}>
              Cancel
            </button>
            <button type="button" disabled={busy || addError !== null} onClick={() => void add()}>
              Add
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="template-add">
          <button
            ref={addRef}
            type="button"
            disabled={!profiles}
            onClick={() => setAdding({ name: '', folder: null, billing: 'own' })}
          >
            Add account
          </button>
        </div>
      )}
    </section>
  )
}

const UPDATE_CHOICES: { value: UpdateStrategy; label: string; hint: string }[] = [
  { value: 'rebase', label: 'Rebase', hint: 'replays the task’s commits on top of the base (git rebase)' },
  { value: 'merge', label: 'Merge', hint: 'adds a merge commit (git merge --no-edit)' },
]

const APPEARANCE_CHOICES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const TERMINAL_MODE_CHOICES: { value: TerminalMode; label: string }[] = [
  { value: 'direct', label: 'Direct (recommended)' },
  { value: 'classic', label: 'Classic (tmux attach)' },
]

/**
 * Edits the app settings. Fields are checked as you type; Save is off while one is invalid, and a button beside it
 * counts them and takes you to the first (it may be scrolled out of view). Esc cancels; with changes made, it asks
 * first (a second Esc discards them), as a stray Esc would lose them all. Cancel discards at once.
 */
export function SettingsDialog(props: {
  settings: Settings
  /** The edited settings, a patch over the current ones. */
  onSave: (settings: EditableSettings) => Promise<void>
  onCancel: () => void
  /** The Claude accounts section; left out without it (tests of the other sections). */
  accounts?: AccountsProps
}): React.JSX.Element {
  const [form, setForm] = useState<SettingsForm>(() => toForm(props.settings))
  const [start] = useState(form)
  const discard = useConfirmDiscard(() => formChanged(start, form), props.onCancel)
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
  const toFix = errorCount(errors)
  const formRef = useRef<HTMLFormElement>(null)
  const toFixId = useId()
  const notificationsHintId = useId()
  const statusBarHintId = useId()
  const remoteHintId = useId()
  const skipHintId = useId()
  const strategyHintId = useId()
  const appearanceHintId = useId()
  useRestoreFocus()

  const set =
    (
      field: Exclude<
        keyof SettingsForm,
        | 'notifications'
        | 'remoteControl'
        | 'skipPermissions'
        | 'updateStrategy'
        | 'showStatusBar'
        | 'taskTemplates'
        | 'appearance'
        | 'terminalMode'
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
        ref={formRef}
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
          if (!busyRef.current) discard.escape() // like Cancel: a failed save keeps the dialog and the edits
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

        {props.accounts && <ClaudeAccountsSection {...props.accounts} />}

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

        <section className="settings-section" aria-label="Appearance">
          <h3>Appearance</h3>
          <fieldset className="settings-choice" aria-label="Appearance" aria-describedby={appearanceHintId}>
            <div className="settings-choice-row">
              {APPEARANCE_CHOICES.map(({ value, label }) => (
                <label key={value} className="settings-choice-option">
                  <input
                    type="radio"
                    name="appearance"
                    value={value}
                    checked={form.appearance === value}
                    onChange={() => setForm((f) => ({ ...f, appearance: value }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p id={appearanceHintId} className="settings-hint">
              Light or dark colours for the whole window: the terminal, code and diagrams too. System follows your
              desktop&apos;s setting as it changes.
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
                <NumberInput
                  {...aria}
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
                <NumberInput
                  {...aria}
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
          <Field
            label="Terminal"
            hint="Direct shows each program's own output; Classic attaches a tmux client, as before. Switching re-opens the terminal."
          >
            {(aria) => (
              <select
                {...aria}
                value={form.terminalMode}
                onChange={(e) => setForm((f) => ({ ...f, terminalMode: e.target.value as TerminalMode }))}
              >
                {TERMINAL_MODE_CHOICES.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
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
              When Claude finishes or needs your input in a task or folder you aren&apos;t looking at, and when a task
              or the day reaches 80% or 100% of its budget.
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

        <section className="settings-section" aria-label="Budgets">
          <h3>Budgets</h3>
          <div className="settings-row">
            <Field
              label="Daily budget"
              hint="Estimated cost of all tasks and folders today, since midnight."
              error={errors.dailyBudget}
              suffix="USD"
            >
              {(aria) => (
                <input
                  {...aria}
                  inputMode="decimal"
                  placeholder="None"
                  value={form.dailyBudget}
                  onChange={set('dailyBudget')}
                />
              )}
            </Field>
            <Field
              label="Task budget"
              hint="Each task's estimated cost, all time. A task can have its own: “Set budget…” in its header's ⋯ menu, or the palette."
              error={errors.taskBudget}
              suffix="USD"
            >
              {(aria) => (
                <input
                  {...aria}
                  inputMode="decimal"
                  placeholder="None"
                  value={form.taskBudget}
                  onChange={set('taskBudget')}
                />
              )}
            </Field>
          </div>
          <p className="settings-note">
            A badge turns amber at 80% and red at 100%, with a notification at each (when notifications are on). Leave a
            field empty for no budget.
          </p>
        </section>

        <TaskTemplatesSection
          templates={form.taskTemplates}
          errors={errors.taskTemplates}
          onChange={(update) => setForm((f) => ({ ...f, taskTemplates: update(f.taskTemplates) }))}
        />

        {/* Stays at the bottom of the scrolling dialog, so Save and the Esc question are always in view. */}
        <div className="settings-footer">
          {discard.prompt}
          <div className="dialog-actions">
            {toFix > 0 && (
              <button
                type="button"
                id={toFixId}
                className="link-button dialog-actions-hint settings-to-fix"
                onClick={() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()}
              >
                {plural(toFix, 'field')} to fix
              </button>
            )}
            <button type="button" onClick={props.onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !parsed.settings}
              aria-describedby={toFix > 0 ? toFixId : undefined}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
