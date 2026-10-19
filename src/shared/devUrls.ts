/** The most dev-server URLs getDevUrls reports for a task or folder. */
export const MAX_DEV_URLS = 5

/**
 * Terminal escape sequences: CSI (colours, cursor moves), OSC (titles, OSC 8 hyperlinks) ended by BEL or ST,
 * character set designations, and the other two-character escapes. Vite colours the port of its URL on its own.
 */
const ANSI =
  // eslint-disable-next-line no-control-regex -- escape sequences are exactly what is removed
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>]/g

/** `text` without terminal escape sequences (see ANSI); line breaks and tabs stay. */
export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/**
 * A loopback http(s) URL with an explicit port: the scheme (not glued to a word before it), the host, the port,
 * then whatever URL characters follow on the line, checked in code (see findDevUrls).
 */
const CANDIDATE =
  /(?<![A-Za-z0-9+.-])(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})([^\s"'<>`\\^{}|]*)/gi
/** Punctuation after a URL in prose or logs ("at http://…/.", "(http://…)"), never the URL's own end. */
const TRAILING = /[.,;:!?)\]}]+$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The URL to open for one CANDIDATE match, or null when it isn't one: the port must be 1–65535, and what follows
 * it a path, query or fragment (`http://localhost:3000@evil.example` or `:3000abc` is something else). 0.0.0.0
 * (listening on every address) opens as localhost.
 */
function devUrl(scheme: string, host: string, port: string, after: string): string | null {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  const rest = after.replace(TRAILING, '')
  if (rest !== '' && !/^[/?#]/.test(rest)) return null
  const name = host.toLowerCase() === '0.0.0.0' ? 'localhost' : host
  let url: URL
  try {
    url = new URL(`${scheme}://${name}:${n}${rest}`)
  } catch {
    return null
  }
  const ok =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOOPBACK.has(url.hostname) &&
    url.username === '' &&
    url.password === ''
  return ok ? url.href : null
}

/**
 * The dev-server URLs in a terminal's text: http(s) on localhost, 127.0.0.1, 0.0.0.0 (opened as localhost) or
 * [::1], with a port from 1 to 65535 and an optional path, as `URL` normalizes them (`http://localhost:5173/`).
 * Escape sequences are removed first. A URL never spans lines: the capture joins the lines the terminal wrapped
 * (`capture-pane -J`), and a line break, a carriage-return redraw included, ends it. Newest (lowest in the text)
 * first, each once.
 */
export function findDevUrls(text: string): string[] {
  const found: string[] = []
  for (const line of stripAnsi(text).split(/\r\n|\r|\n/)) {
    for (const m of line.matchAll(CANDIDATE)) {
      const url = devUrl(m[1], m[2], m[3], m[4])
      if (url) found.push(url)
    }
  }
  const seen = new Set<string>()
  const newest: string[] = []
  for (let i = found.length - 1; i >= 0; i--) {
    if (seen.has(found[i])) continue
    seen.add(found[i])
    newest.push(found[i])
  }
  return newest
}

/** A URL as a link shows it: no `http://` (https stays), and no lone `/` path. */
export function devUrlLabel(url: string): string {
  const short = url.replace(/^http:\/\//, '')
  return short.replace(/^((?:https:\/\/)?[^/?#]+)\/$/, '$1')
}
