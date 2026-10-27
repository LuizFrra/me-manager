import type { ChangeStatus } from '../../../shared/types'

export const STATUS_NAMES: Record<ChangeStatus, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  U: 'Untracked',
}

export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const README = /^readme\.(md|markdown)$/i
const INDEX = /^index\.(md|markdown)$/i

/**
 * The page that stands for folder `dir` (as a Markdown link to the folder means): its README, else its index.md,
 * directly inside it; null when it has neither (or isn't a folder of `paths`).
 */
export function folderIndex(paths: readonly string[], dir: string): string | null {
  const prefix = `${dir}/`
  let index: string | null = null
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue
    const name = p.slice(prefix.length)
    if (name.includes('/')) continue
    if (README.test(name)) return p
    if (INDEX.test(name)) index ??= p
  }
  return index
}
