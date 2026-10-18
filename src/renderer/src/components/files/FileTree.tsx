import { useMemo } from 'react'
import type { ChangeStatus } from '../../../../shared/types'
import type { TreeNode } from '../../lib/fileTree'
import { ancestorDirs, flattenTree } from '../../lib/fileTree'
import { STATUS_NAMES } from '../../lib/files'
import { VirtualRowList } from './VirtualRowList'

export interface FileTreeProps {
  nodes: TreeNode[]
  selected?: string
  /** Change status by path, shown as a badge. */
  badges: ReadonlyMap<string, ChangeStatus>
  /** Keep it stable (useCallback): the visible rows are recomputed whenever it changes. */
  isOpen: (dir: string) => boolean
  onToggle: (dir: string) => void
  onSelect: (path: string) => void
}

const indent = (depth: number): number => 6 + depth * 14

/**
 * The file tree, flattened into the rows it shows (open directories' contents, depth-indented), in a list that
 * renders only the rows in view once there are many. ←/→ close and open directories, or move to the parent / the
 * first child, as in a tree view; ↑/↓ move between rows.
 */
export function FileTree(p: FileTreeProps): React.JSX.Element {
  const { nodes, isOpen, badges, selected } = p
  const rows = useMemo(() => flattenTree(nodes, isOpen), [nodes, isOpen])
  const changedDirs = useMemo(() => new Set([...badges.keys()].flatMap(ancestorDirs)), [badges])
  const selectedIndex = useMemo(
    () => (selected ? rows.findIndex((r) => !r.node.dir && r.node.path === selected) : -1),
    [rows, selected],
  )

  const onRowKey = (e: React.KeyboardEvent, index: number): number | null => {
    const { node, depth } = rows[index]
    if (e.key === 'ArrowRight' && node.dir) {
      if (!isOpen(node.path)) p.onToggle(node.path)
      else if (node.children.length > 0) return index + 1
      e.preventDefault()
      return null
    }
    if (e.key === 'ArrowLeft') {
      if (node.dir && isOpen(node.path)) {
        e.preventDefault()
        p.onToggle(node.path)
        return null
      }
      for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth) return i
    }
    return null
  }

  const renderRow = (index: number, style: React.CSSProperties | undefined): React.ReactNode => {
    const { node, depth } = rows[index]
    const rowStyle = { ...style, paddingLeft: indent(depth) }
    if (node.dir) {
      const open = isOpen(node.path)
      return (
        <button
          key={node.path}
          data-row={index}
          className="tree-row tree-dir"
          style={rowStyle}
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
      )
    }
    const status = badges.get(node.path)
    const isSelected = selected === node.path
    return (
      <button
        key={node.path}
        data-row={index}
        className={isSelected ? 'tree-row tree-file selected' : 'tree-row tree-file'}
        style={rowStyle}
        aria-current={isSelected ? 'true' : undefined}
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
  }

  return (
    <VirtualRowList
      className="file-tree"
      label="Files"
      count={rows.length}
      selectedIndex={selectedIndex}
      selectedKey={selected}
      renderRow={renderRow}
      onRowKey={onRowKey}
    />
  )
}
