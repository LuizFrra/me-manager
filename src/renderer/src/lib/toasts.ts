import { useCallback, useRef, useState } from 'react'

export interface Toast {
  id: number
  message: string
}

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useToasts(): { toasts: Toast[]; showError: (err: unknown) => void; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const showError = useCallback(
    (err: unknown) => {
      const id = ++nextId.current
      setToasts((ts) => [...ts, { id, message: cleanError(err) }])
      setTimeout(() => dismiss(id), 8000)
    },
    [dismiss],
  )
  return { toasts, showError, dismiss }
}
