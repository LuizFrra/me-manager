import type { PrereqResult } from '../../../shared/types'

export function PrereqScreen({ result, onRetry }: { result: PrereqResult; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="prereq">
      <h1>Missing tools</h1>
      <p>me-manager needs these command-line tools:</p>
      <ul>
        {result.missing.map((m) => (
          <li key={m.tool}>
            <strong>{m.tool}</strong> — <code>{m.hint}</code>
          </li>
        ))}
      </ul>
      <button onClick={onRetry}>Check again</button>
    </div>
  )
}
