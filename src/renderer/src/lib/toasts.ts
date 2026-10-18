import { useCallback, useRef, useState } from 'react'

export interface Toast {
  id: number
  /** An error stays for a while; an info toast is a short, neutral confirmation ("Copied branch name"). */
  kind: 'error' | 'info'
  message: string
}

const ERROR_MS = 8000
export const INFO_MS = 2000

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useToasts(): {
  toasts: Toast[]
  showError: (err: unknown) => void
  showInfo: (message: string) => void
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
  // A new confirmation replaces the previous one instead of stacking up.
  const showInfo = useCallback(
    (message: string) => {
      const id = ++nextId.current
      setToasts((ts) => [...ts.filter((t) => t.kind !== 'info'), { id, kind: 'info', message }])
      setTimeout(() => dismiss(id), INFO_MS)
    },
    [dismiss],
  )
  return { toasts, showError, showInfo, dismiss }
}
