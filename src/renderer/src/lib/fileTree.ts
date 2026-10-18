import type { FileList } from '../../../shared/types'

export interface TreeNode {
  name: string
  path: string
  dir: boolean
  children: TreeNode[]
}

const byName = (a: TreeNode, b: TreeNode): number => {
  const la = a.name.toLowerCase()
  const lb = b.name.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Dirs first, then files, each by name; in place, recursively. */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => (a.dir === b.dir ? byName(a, b) : a.dir ? -1 : 1))
  for (const n of nodes) if (n.dir) sortNodes(n.children)
  return nodes
}

/**
 * Builds a tree from root-relative POSIX paths: dirs first, then files, alphabetical (case-insensitive). Each
 * path's prefixes are built up one segment at a time, so a deep path costs its length, not its depth squared.
 */
export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  const dirs = new Map<string, TreeNode>([['', root]])
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    let parent = root
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      path = i === 0 ? parts[0] : `${path}/${parts[i]}`
      if (i === parts.length - 1) {
        parent.children.push({ name: parts[i], path, dir: false, children: [] })
        break
      }
      let dir = dirs.get(path)
      if (!dir) {
        dir = { name: parts[i], path, dir: true, children: [] }
        dirs.set(path, dir)
        parent.children.push(dir)
      }
      parent = dir
    }
  }
  return sortNodes(root.children)
}

/** One visible line of the tree: a node and how deep it is. */
export interface TreeRow {
  node: TreeNode
  depth: number
}

/** The tree as the rows it shows, top to bottom: every node whose ancestors are all open. */
export function flattenTree(nodes: readonly TreeNode[], isOpen: (dir: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: readonly TreeNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth })
      if (node.dir && isOpen(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return rows
}

/**
 * `fn` with its results remembered per argument identity (weakly): calling it again with the same array returns the
 * same result without recomputing. For derived data of polled lists that only get a new identity when they change.
 */
export function memoByIdentity<A extends object, R>(fn: (arg: A) => R): (arg: A) => R {
  const cache = new WeakMap<A, R>()
  return (arg) => {
    if (cache.has(arg)) return cache.get(arg) as R
    const result = fn(arg)
    cache.set(arg, result)
    return result
  }
}

/** Case-insensitive substring match on the full path; a blank query keeps everything. */
export function filterPaths(paths: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return paths
  return paths.filter((p) => p.toLowerCase().includes(q))
}

/** The directories containing `path`, outermost first. */
export function ancestorDirs(path: string | undefined): string[] {
  if (!path) return []
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** Whether two file lists are the same: compared path by path, without a JSON copy of a list of up to 50k paths. */
export function sameFileList(a: FileList | null, b: FileList): boolean {
  if (!a || a.truncated !== b.truncated || a.paths.length !== b.paths.length) return false
  for (let i = 0; i < a.paths.length; i++) if (a.paths[i] !== b.paths[i]) return false
  return true
}
