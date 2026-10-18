import { useId, useRef, useState } from 'react'
import type { ThemeColor, ThemeStyle } from '../../../shared/types'
import { MAX_THEME_ICON, THEME_COLORS, THEME_EMOJI, themeColorCss, themeIconError } from '../../../shared/themeStyle'
import { useRestoreFocus } from '../lib/useRestoreFocus'

/**
 * "Customize theme…": a colour from the fixed palette (or none) and an emoji icon, picked from a small grid or
 * typed / pasted into the field. The preview shows the sidebar row as it will look. Esc cancels.
 */
export function ThemeStyleDialog(props: {
  themeName: string
  initial: ThemeStyle
  /** Saves the style; rejects (the app shows why) to keep the dialog open. */
  onSave: (style: ThemeStyle) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [color, setColor] = useState<ThemeColor | undefined>(props.initial.color)
  const [icon, setIcon] = useState(props.initial.icon ?? '')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const iconErrorId = useId()
  const iconHintId = useId()
  useRestoreFocus()

  const iconError = themeIconError(icon)
  const trimmed = icon.trim()
  const css = themeColorCss(color)

  const save = async (): Promise<void> => {
    if (busyRef.current || iconError) return
    busyRef.current = true
    setBusy(true)
    try {
      await props.onSave({ ...(color ? { color } : {}), ...(trimmed ? { icon: trimmed } : {}) })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <form
        className="dialog theme-style-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Customize theme"
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
        <h2>
          Customize theme <span className="dialog-title-context">{props.themeName}</span>
        </h2>

        <div
          className={`theme-preview${css ? ' has-color' : ''}`}
          style={css ? ({ '--theme-color': css } as React.CSSProperties) : undefined}
          aria-hidden="true"
        >
          <span className="theme-preview-arrow">▼</span>
          {trimmed && !iconError && <span className="theme-icon">{trimmed}</span>}
          <span className="theme-preview-name">{props.themeName}</span>
        </div>

        <fieldset className="theme-style-field">
          <legend>Colour</legend>
          <div className="theme-swatches">
            <label className="theme-swatch theme-swatch-none" title="No colour">
              <input
                type="radio"
                name="theme-color"
                aria-label="No colour"
                checked={color === undefined}
                onChange={() => setColor(undefined)}
              />
              <span aria-hidden="true" />
            </label>
            {THEME_COLORS.map((c) => (
              <label key={c.name} className="theme-swatch" title={c.label}>
                <input
                  type="radio"
                  name="theme-color"
                  aria-label={c.label}
                  checked={color === c.name}
                  onChange={() => setColor(c.name)}
                />
                <span aria-hidden="true" style={{ background: c.css }} />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="theme-style-field">
          <legend>Icon</legend>
          <div className="emoji-grid" role="group" aria-label="Common emoji">
            {THEME_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="emoji-choice"
                aria-label={`Icon ${emoji}`}
                aria-pressed={trimmed === emoji}
                onClick={() => setIcon(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="theme-icon-row">
            <input
              autoFocus
              className="theme-icon-input"
              aria-label="Emoji"
              aria-invalid={Boolean(iconError)}
              aria-describedby={iconError ? iconErrorId : iconHintId}
              placeholder="Type or paste one"
              spellCheck={false}
              maxLength={MAX_THEME_ICON * 2}
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
            />
            <button type="button" onClick={() => setIcon('')} disabled={trimmed === ''}>
              No icon
            </button>
          </div>
          {iconError ? (
            <p id={iconErrorId} className="dialog-field-error">
              {iconError}
            </p>
          ) : (
            <p id={iconHintId} className="dialog-field-hint">
              One emoji, shown before the theme&apos;s name and next to its tasks in the palette.
            </p>
          )}
        </fieldset>

        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || Boolean(iconError)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
