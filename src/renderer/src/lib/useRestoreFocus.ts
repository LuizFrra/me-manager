import { useEffect, useState } from 'react'

/**
 * For overlays: remembers what had focus when the component mounted (usually the terminal) and focuses it again
 * on unmount, unless something else has taken focus in the meantime (e.g. a dialog the overlay opened).
 */
export function useRestoreFocus(): void {
  // Read during the first render: by the time effects run, the overlay's autoFocus has already moved focus.
  const [previous] = useState(() => document.activeElement)
  useEffect(
    () => () => {
      const now = document.activeElement
      if (now !== null && now !== document.body) return
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    },
    [previous],
  )
}
