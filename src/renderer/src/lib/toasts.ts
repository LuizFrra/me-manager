import { useCallback, useRef, useState } from 'react'

/** A button on a toast, e.g. "Undo". Clicking it dismisses the toast, then runs `run`. */
export interface ToastAction {
  label: string
  run: () => void | Promise<void>
}

export interface Toast {
  id: number
  /** An error stays for a while; an info toast is a short, neutral confirmation ("Copied branch name"). */
  kind: 'error' | 'info'
  message: string
  /** Info toasts only: a button, shown for ACTION_MS instead of INFO_MS. */
  action?: ToastAction
}

export interface InfoOptions {
  action?: ToastAction
}

const ERROR_MS = 8000
export const INFO_MS = 2000
/** How long an info toast with an action (an "Undo") stays. */
export const ACTION_MS = 8000

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useToasts(): {
  toasts: Toast[]
  showError: (err: unknown) => void
  showInfo: (message: string, options?: InfoOptions) => void
  dismiss: (id: number) => void
} {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const showError = useCallback(
    (err: unknown) => {
      const id = ++nextId.current
      setToasts((ts) => [...ts, { id, kind: 'error', message: cleanError(err) }])
      setTimeout(() => dismiss(id), ERROR_MS)
    },
    [dismiss],
  )
  // A new confirmation replaces the previous plain one instead of stacking up. One with an action (an "Undo")
  // is never replaced, so a later "Copied…" can't take the undo away; it goes when it times out or is used.
  const showInfo = useCallback(
    (message: string, options: InfoOptions = {}) => {
      const id = ++nextId.current
      const toast: Toast = { id, kind: 'info', message, ...(options.action ? { action: options.action } : {}) }
      setToasts((ts) => [...ts.filter((t) => t.kind !== 'info' || t.action), toast])
      setTimeout(() => dismiss(id), options.action ? ACTION_MS : INFO_MS)
    },
    [dismiss],
  )
  return { toasts, showError, showInfo, dismiss }
}
