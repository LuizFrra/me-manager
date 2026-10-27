import { useState } from 'react'
import type { PrereqResult } from '../../../shared/types'
import { Spark } from './icons'

/**
 * Shown instead of the app while git, tmux or claude can't be found. Each install hint can be copied, and "Check
 * again" says it is checking (the login shell is asked for its PATH again, which can take a moment).
 */
export function PrereqScreen({
  result,
  onRetry,
}: {
  result: PrereqResult
  onRetry: () => Promise<void>
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const retry = (): void => {
    setChecking(true)
    void onRetry().finally(() => setChecking(false))
  }
  const copy = (tool: string, hint: string): void => {
    void navigator.clipboard.writeText(hint).then(
      () => setCopied(tool),
      () => setCopied(null),
    )
  }
  return (
    <div className="prereq">
      <div className="welcome-mark">
        <Spark size={32} />
      </div>
      <h1>Missing tools</h1>
      <p>me-manager needs these command-line tools:</p>
      <ul>
        {result.missing.map((m) => (
          <li key={m.tool}>
            <strong>{m.tool}</strong> — <code>{m.hint}</code>{' '}
            <button className="prereq-copy" aria-label={`Copy the ${m.tool} hint`} onClick={() => copy(m.tool, m.hint)}>
              {copied === m.tool ? 'Copied' : 'Copy'}
            </button>
          </li>
        ))}
      </ul>
      <button className="primary" onClick={retry} disabled={checking} aria-busy={checking}>
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  )
}
