const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Resolve a link/image href found in `fromFile` (root-relative) to a root-relative path, or null if it escapes the
 * root or is not a relative path. Strips #fragment and ?query; decodes %20 etc.
 */
export function resolveRelative(fromFile: string, href: string): string | null {
  const trimmed = href.trim()
  if (trimmed === '' || SCHEME.test(trimmed) || trimmed.startsWith('//')) return null

  const cut = trimmed.search(/[?#]/)
  const raw = cut === -1 ? trimmed : trimmed.slice(0, cut)
  if (raw === '') return null

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const parts: string[] = []
  if (!decoded.startsWith('/')) {
    parts.push(...fromFile.split('/').filter((p) => p !== '' && p !== '.'))
    parts.pop() // drop the file name, keep its directory
  }
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** True only for absolute http: or https: URLs. */
export function isExternal(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  try {
    const { protocol } = new URL(href)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The decoded `#fragment` of a link, or null when it has none (or it doesn't decode). */
export function linkFragment(href: string): string | null {
  const hash = href.indexOf('#')
  if (hash === -1 || hash === href.length - 1) return null
  try {
    return decodeURIComponent(href.slice(hash + 1))
  } catch {
    return null
  }
}

/** The lines a GitHub-style line anchor names (`L12`, `L12-L20`, `L12-20`), or null for any other fragment. */
export function lineFragment(fragment: string | null): { start: number; end: number } | null {
  const m = fragment === null ? null : /^L(\d+)(?:-L?(\d+))?$/.exec(fragment)
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] === undefined ? a : Number(m[2])
  if (a < 1 || b < 1) return null
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/**
 * The anchor GitHub gives a heading with this text: lowercased, punctuation dropped (letters, digits, `_` and `-`
 * kept), spaces turned into dashes. Repeats get `-1`, `-2`… (see MarkdownView).
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}
