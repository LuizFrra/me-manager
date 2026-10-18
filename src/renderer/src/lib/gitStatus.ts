import type { TaskGitStatus } from '../../../shared/types'

export interface GitBadge {
  kind: 'ahead' | 'behind' | 'dirty'
  /** Compact text: ↑3, ↓1, ●2. */
  text: string
  /** Tooltip, e.g. "3 commits ahead of origin/main". */
  title: string
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The sidebar badges for a task's git status; only non-zero counts get one. */
export function gitBadges(status: TaskGitStatus, baseRef: string): GitBadge[] {
  const badges: GitBadge[] = []
  if (status.ahead > 0)
    badges.push({
      kind: 'ahead',
      text: `↑${status.ahead}`,
      title: `${plural(status.ahead, 'commit')} ahead of ${baseRef}`,
    })
  if (status.behind > 0)
    badges.push({
      kind: 'behind',
      text: `↓${status.behind}`,
      title: `${plural(status.behind, 'commit')} behind ${baseRef}`,
    })
  if (status.uncommitted > 0)
    badges.push({
      kind: 'dirty',
      text: `●${status.uncommitted}`,
      title: plural(status.uncommitted, 'uncommitted file'),
    })
  return badges
}

/** One line for the header: how the task stands against its base. */
export function baseSummary(status: TaskGitStatus, baseRef: string): string {
  if (status.baseMissing) return `Base ${baseRef} not found`
  if (status.ahead === 0 && status.behind === 0) return `Up to date with ${baseRef}`
  const { ahead, behind } = status
  if (ahead > 0 && behind > 0) return `${ahead} ahead, ${behind} behind ${baseRef}`
  if (ahead > 0) return `${plural(ahead, 'commit')} ahead of ${baseRef}`
  return `${plural(behind, 'commit')} behind ${baseRef}`
}
