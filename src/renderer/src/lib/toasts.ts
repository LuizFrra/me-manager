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
  /** Info toasts only: something to look at (a budget reached), marked ⚠ instead of ✓. */
  warning?: true
}

export interface InfoOptions {
  action?: ToastAction
  warning?: boolean
}

const ERROR_MS = 8000
export const INFO_MS = 2000
/** How long an info toast with an action (an "Undo") stays. */
export const ACTION_MS = 8000

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Once the pointer or focus leaves a held toast, it stays at least this long before it goes. */
export const RESUME_MS = 2000

export function useToasts(): {
  toasts: Toast[]
  showError: (err: unknown) => void
  showInfo: (message: string, options?: InfoOptions) => void
  dismiss: (id: number) => void
  /** Keeps a toast up while it is hovered or focused (being read, or its Undo being reached for). */
  hold: (id: number) => void
  /** Lets a held toast go again, after RESUME_MS. */
  release: (id: number) => void
} {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  // The error toasts shown, by message.
  const errors = useRef(new Map<string, number>())
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    for (const [message, errorId] of errors.current) if (errorId === id) errors.current.delete(message)
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])
  const expire = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id))
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      )
    },
    [dismiss],
  )
  const hold = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
  }, [])
  const release = useCallback(
    (id: number) => {
      if (!timers.current.has(id)) expire(id, RESUME_MS)
    },
    [expire],
  )
  // The same error again (a failing poll, a repeated click) doesn't stack a copy: the one shown stays longer.
  const showError = useCallback(
    (err: unknown) => {
      const message = cleanError(err)
      const same = errors.current.get(message)
      if (same !== undefined) {
        if (timers.current.has(same)) expire(same, ERROR_MS) // not while held: it stays anyway
        return
      }
      const id = ++nextId.current
      errors.current.set(message, id)
      setToasts((ts) => [...ts, { id, kind: 'error', message }])
      expire(id, ERROR_MS)
    },
    [expire],
  )
  // A new confirmation replaces the previous plain one instead of stacking up. One with an action (an "Undo")
  // is never replaced, so a later "Copied…" can't take the undo away; it goes when it times out or is used.
  const showInfo = useCallback(
    (message: string, options: InfoOptions = {}) => {
      const id = ++nextId.current
      const toast: Toast = {
        id,
        kind: 'info',
        message,
        ...(options.action ? { action: options.action } : {}),
        ...(options.warning ? { warning: true as const } : {}),
      }
      setToasts((ts) => [...ts.filter((t) => t.kind !== 'info' || t.action), toast])
      expire(id, options.action ? ACTION_MS : INFO_MS)
    },
    [expire],
  )
  return { toasts, showError, showInfo, dismiss, hold, release }
}
