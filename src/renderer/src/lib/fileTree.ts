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

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  const dirs = nodes.filter((n) => n.dir).sort(byName)
  const files = nodes.filter((n) => !n.dir).sort(byName)
  for (const d of dirs) d.children = sortNodes(d.children)
  return [...dirs, ...files]
}

/** Builds a tree from root-relative POSIX paths: dirs first, then files, alphabetical (case-insensitive). */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  const dirs = new Map<string, TreeNode>([['', root]])
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    let parent = root
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/')
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

/** Case-insensitive substring match on the full path; a blank query keeps everything. */
export function filterPaths(paths: string[], query: string): string[] {
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
