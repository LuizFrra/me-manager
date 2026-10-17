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
