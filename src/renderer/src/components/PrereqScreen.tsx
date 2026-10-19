import type { PrereqResult } from '../../../shared/types'
import { Spark } from './icons'

export function PrereqScreen({ result, onRetry }: { result: PrereqResult; onRetry: () => void }): React.JSX.Element {
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
            <strong>{m.tool}</strong> — <code>{m.hint}</code>
          </li>
        ))}
      </ul>
      <button className="primary" onClick={onRetry}>
        Check again
      </button>
    </div>
  )
}
