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

/**
 * The start of a long error, for a line read at a glance: at most `max` characters, cut at a word, with an
 * ellipsis. `more` when it was cut, so the full text can be offered.
 */
export function errorSummary(message: string, max = 160): { summary: string; more: boolean } {
  const text = message.trim()
  if (text.length <= max) return { summary: text, more: false }
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return { summary: `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`, more: true }
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
      const toast: Toast = {
        id,
        kind: 'info',
        message,
        ...(options.action ? { action: options.action } : {}),
        ...(options.warning ? { warning: true as const } : {}),
      }
      setToasts((ts) => [...ts.filter((t) => t.kind !== 'info' || t.action), toast])
      setTimeout(() => dismiss(id), options.action ? ACTION_MS : INFO_MS)
    },
    [dismiss],
  )
  return { toasts, showError, showInfo, dismiss }
}
