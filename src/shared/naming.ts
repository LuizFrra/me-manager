import type { Target } from './types'

const MAX_SLUG = 40
/** Hex digits of the hash a slug ends with when its name has letters or digits ASCII can't spell. */
const HASH_DIGITS = 8

/** Latin letters that NFKD doesn't split into a base letter and an accent, spelled in ASCII. */
const LATIN_LETTERS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
}

/** 32-bit FNV-1a of the text's UTF-16 code units, as HASH_DIGITS hex digits. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(HASH_DIGITS, '0')
}

/** At most `max` characters, without a trailing dash. */
const cut = (slug: string, max: number): string => slug.slice(0, max).replace(/-+$/, '')

/**
 * A name as a slug for branches, worktree folders and tmux sessions: ASCII lowercase letters, digits and dashes, at
 * most MAX_SLUG characters; '' when the name has no letter or digit. Accents are dropped (`Ação` → `acao`). Letters
 * or digits ASCII can't spell (Cyrillic, CJK…) put a hash of the name's words at the end, so such a name still gets
 * a slug, and two that differ only there get different ones (names that differ only in case, the same one).
 */
export function slugify(name: string): string {
  const plain = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => LATIN_LETTERS[c])
  const ascii = plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const words = plain.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  if (words === ascii) return cut(ascii, MAX_SLUG)
  const head = cut(ascii, MAX_SLUG - HASH_DIGITS - 1)
  return head ? `${head}-${hash(words)}` : hash(words)
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
