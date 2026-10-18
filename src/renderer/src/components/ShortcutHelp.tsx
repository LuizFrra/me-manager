import { useEffect, useRef } from 'react'
import { shortcutHelp } from '../lib/shortcuts'
import { useRestoreFocus } from '../lib/useRestoreFocus'

/** The "Keyboard shortcuts" overlay. Esc, the ✕ button or a click outside closes it. */
export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useRestoreFocus()
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="overlay help-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          onClose()
        }}
      >
        <div className="help-header">
          <h2>Keyboard shortcuts</h2>
          <button className="help-close" aria-label="Close keyboard shortcuts" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="help-list">
          {shortcutHelp().map((entry) => (
            <div key={entry.description} className="help-row">
              <dt>{entry.description}</dt>
              <dd>
                {entry.keys.map((keys, i) => (
                  <span key={keys} className="help-chord">
                    {i > 0 && <span className="help-or">or</span>}
                    <kbd>{keys}</kbd>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
