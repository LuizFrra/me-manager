import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function with a stable identity that always calls the latest `fn`. Use it for callback props that are
 * passed down to memoized children, so a parent re-render with a fresh closure doesn't invalidate them.
 * Must not be called during render (it would see the previous render's `fn`).
 */
export function useLatestCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
