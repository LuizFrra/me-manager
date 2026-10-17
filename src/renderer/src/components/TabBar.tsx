import type { TabInfo } from '../../../shared/types'

export function TabBar(props: {
  tabs: TabInfo[]
  onSelect: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onRestartClaude: () => void
}): React.JSX.Element {
  const hasClaude = props.tabs.some((t) => t.name === 'claude')
  return (
    <div className="tabbar" role="tablist">
      {props.tabs.map((t) => (
        <div key={t.index} className={t.active ? 'tab active' : 'tab'}>
          <button role="tab" aria-selected={t.active} onClick={() => props.onSelect(t.index)}>
            {t.name}
          </button>
          <button className="tab-close" aria-label={`Close tab ${t.name}`} onClick={() => props.onClose(t.index)}>
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" aria-label="New shell tab" onClick={props.onNew}>
        +
      </button>
      {!hasClaude && props.tabs.length > 0 && (
        <button className="restart" onClick={props.onRestartClaude}>
          Restart Claude
        </button>
      )}
    </div>
  )
}
