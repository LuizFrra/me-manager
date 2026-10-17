import { useMemo } from 'react'
import type { ChangeStatus } from '../../../../shared/types'
import type { TreeNode } from '../../lib/fileTree'
import { ancestorDirs } from '../../lib/fileTree'
import { STATUS_NAMES } from '../../lib/files'

export interface FileTreeProps {
  nodes: TreeNode[]
  selected?: string
  /** Change status by path, shown as a badge. */
  badges: Map<string, ChangeStatus>
  isOpen: (dir: string) => boolean
  onToggle: (dir: string) => void
  onSelect: (path: string) => void
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: 6 + depth * 14 })

export function FileTree(p: FileTreeProps): React.JSX.Element {
  const changedDirs = useMemo(() => new Set([...p.badges.keys()].flatMap(ancestorDirs)), [p.badges])

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.dir) {
        const open = p.isOpen(node.path)
        return (
          <div key={node.path} role="group" aria-label={node.name}>
            <button
              className="tree-row tree-dir"
              style={indent(depth)}
              aria-expanded={open}
              title={node.path}
              onClick={() => p.onToggle(node.path)}
            >
              <span className={open ? 'tree-caret open' : 'tree-caret'} aria-hidden="true">
                ▸
              </span>
              <span className="tree-name">{node.name}</span>
              {changedDirs.has(node.path) && <span className="tree-dot" title="Contains changes" />}
            </button>
            {open && renderNodes(node.children, depth + 1)}
          </div>
        )
      }
      const status = p.badges.get(node.path)
      return (
        <button
          key={node.path}
          className={p.selected === node.path ? 'tree-row tree-file selected' : 'tree-row tree-file'}
          style={indent(depth)}
          aria-current={p.selected === node.path ? 'true' : undefined}
          aria-label={status ? `${node.name}, ${STATUS_NAMES[status].toLowerCase()}` : undefined}
          title={node.path}
          onClick={() => p.onSelect(node.path)}
        >
          <span className="tree-caret" aria-hidden="true" />
          <span className="tree-name">{node.name}</span>
          {status && (
            <span className={`badge badge-${status}`} title={STATUS_NAMES[status]}>
              {status}
            </span>
          )}
        </button>
      )
    })

  return <div className="file-tree">{renderNodes(p.nodes, 0)}</div>
}
