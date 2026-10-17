import type { Toast } from '../lib/toasts'

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): React.JSX.Element {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="alert">
          <span>{t.message}</span>
          <button aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
