/**
 * Tasks keep their base as a short name (`origin/main`, or a local `main`): it is what the UI shows and what `gh`
 * wants. git's own lookup of a short name tries tags and local branches before remote-tracking ones, so a tag or a
 * local branch named `origin/main` would silently take its place. Every git call gets the full ref instead,
 * resolved at use time (tasks saved earlier only have the short name).
 */

/** The full refs a task's base name may stand for, the preferred first; refs/… and HEAD stand for themselves. */
export function baseRefCandidates(baseRef: string): string[] {
  if (baseRef === 'HEAD' || baseRef.startsWith('refs/')) return [baseRef]
  const local = `refs/heads/${baseRef}`
  // `origin/x` is origin's branch; a local branch by that name only when origin has none.
  return baseRef.startsWith('origin/') ? [`refs/remotes/${baseRef}`, local] : [local]
}

/**
 * The full ref of `baseRef`: the first candidate that names a commit (checked with `exists`), or the preferred
 * one when none does (so git reports it missing). Throws for an empty or option-like name.
 */
export async function resolveBaseRef(baseRef: string, exists: (fullRef: string) => Promise<boolean>): Promise<string> {
  if (!baseRef || baseRef.startsWith('-')) throw new Error(`Invalid base branch: ${baseRef}`)
  const candidates = baseRefCandidates(baseRef)
  if (candidates.length > 1) {
    for (const ref of candidates) if (await exists(ref)) return ref
  }
  return candidates[0]
}
