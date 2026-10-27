import { useRef, useState } from 'react'

/**
 * Esc in a dialog holding typed text: when `changed()`, the first Esc asks `question` (an alert, with Keep editing,
 * which returns to the field that had focus, and Discard) instead of calling `discard`; a second Esc discards.
 * Unchanged, Esc discards at once. A stray Esc, often pressed to leave a field, would otherwise lose everything
 * typed. `prompt` is the alert to show, null while not asking.
 */
export function useConfirmDiscard(
  changed: () => boolean,
  discard: () => void,
  question = 'Discard your changes? Esc again discards them.',
): { escape: () => void; prompt: React.ReactNode } {
  const [asking, setAsking] = useState(false)
  // What had focus when Esc asked: "Keep editing" goes back to it.
  const editing = useRef<HTMLElement | null>(null)
  const escape = (): void => {
    if (asking || !changed()) return discard()
    editing.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAsking(true)
  }
  const prompt = asking ? (
    <div className="dialog-discard" role="alert">
      <span>{question}</span>
      <button
        type="button"
        onClick={() => {
          setAsking(false)
          editing.current?.focus()
        }}
      >
        Keep editing
      </button>
      <button type="button" className="danger" onClick={discard}>
        Discard
      </button>
    </div>
  ) : null
  return { escape, prompt }
}
