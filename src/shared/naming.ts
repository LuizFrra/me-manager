import type { Target } from './types'

const MAX_SLUG = 40

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
}

export function branchName(themeSlug: string, taskSlug: string): string {
  return `claude/${themeSlug}/${taskSlug}`
}

/** Slugs never contain "_", so the prefixes keep task and folder sessions apart. */
export function sessionName(themeSlug: string, itemSlug: string, taskSlug?: string): string {
  return taskSlug ? `mmt_${themeSlug}_${itemSlug}_${taskSlug}` : `mmf_${themeSlug}_${itemSlug}`
}

export function targetKey(target: Target): string {
  return target.taskId ?? target.itemId
}
