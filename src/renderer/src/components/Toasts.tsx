import type { Toast } from '../lib/toasts'

export function Toasts({
  toasts,
  onDismiss,
  onHold,
  onRelease,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
  /** The pointer or focus is on a toast: it stays until they leave (see useToasts' hold and release). */
  onHold?: (id: number) => void
  onRelease?: (id: number) => void
}): React.JSX.Element {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}${t.action ? ' toast-with-action' : ''}${t.warning ? ' toast-warning' : ''}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => onHold?.(t.id)}
          onMouseLeave={() => onRelease?.(t.id)}
          onFocus={() => onHold?.(t.id)}
          onBlur={() => onRelease?.(t.id)}
        >
          <span className="toast-message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const { run } = t.action!
                onDismiss(t.id)
                void run()
              }}
            >
              {t.action.label}
            </button>
          )}
          <button aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
