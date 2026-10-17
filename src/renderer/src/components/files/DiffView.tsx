export interface DiffViewProps {
  diff: string
}

export function DiffView({ diff }: DiffViewProps): React.JSX.Element {
  return <pre className="diff-raw">{diff}</pre>
}
