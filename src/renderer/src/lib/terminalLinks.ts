/** A link found in a line of terminal text; `start` and `end` are string offsets (`end` exclusive). */
export type TextLink =
  | { kind: 'url'; start: number; end: number; url: string }
  | { kind: 'file'; start: number; end: number; path: string; line?: number }

/** The scheme (not glued to a word before it), then URL characters up to whitespace or a delimiter. */
const URL_CANDIDATE = /(?<![A-Za-z0-9+.-])https?:\/\/[^\s"'<>`\\^{}|]+/gi
/** Punctuation after a URL in prose ("see https://x.dev/a."), never the URL's own end. */
const TRAILING = /[.,;:!?'"]+$/
/** A word of possible path characters: anything up to whitespace, quotes, brackets or list punctuation. */
const PATH_TOKEN = /[^\s()[\]{}<>"'`,;|]+/g
/** `path`, `path:line` or `path:line:col` (compiler and grep style). */
const PATH_WITH_LINE = /^(.+?)(?::(\d+)(?::\d+)?)?$/

/**
 * A URL's text without what a sentence put around it: trailing punctuation, and closing brackets that have no
 * opening one inside the URL (`(see https://x.dev/a)`), while `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its own.
 */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '')
  for (;;) {
    const last = url.at(-1)
    const open = last === ')' ? '(' : last === ']' ? '[' : null
    if (!open) return url
    const opened = url.split(open).length - 1
    const closed = url.split(last as string).length - 1
    if (closed <= opened) return url
    url = url.slice(0, -1).replace(TRAILING, '')
  }
}

/** The http(s) URLs in `line`, each with its position. */
export function findUrls(line: string): Extract<TextLink, { kind: 'url' }>[] {
  const found: Extract<TextLink, { kind: 'url' }>[] = []
  for (const m of line.matchAll(URL_CANDIDATE)) {
    const text = trimUrl(m[0])
    let url: URL
    try {
      url = new URL(text)
    } catch {
      continue
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') continue
    found.push({ kind: 'url', start: m.index, end: m.index + text.length, url: text })
  }
  return found
}

/**
 * The paths in `line` that name a file of the task: relative to its root (`src/a.ts`, `./src/a.ts`) or absolute
 * under it, with an optional `:line` or `:line:col`. Only files in `files` (relative POSIX paths) are links, so
 * words like `e.g.` or `v1.2` never are. URLs are left to findUrls.
 */
export function findFilePaths(line: string, root: string, files: ReadonlySet<string>): TextLink[] {
  const found: TextLink[] = []
  const rootPrefix = root.endsWith('/') ? root : `${root}/`
  for (const m of line.matchAll(PATH_TOKEN)) {
    if (m[0].includes('://')) continue
    // Sentence punctuation after a path ("in src/a.ts.") isn't part of it.
    const token = m[0].replace(/[.:!?]+$/, '')
    const parsed = PATH_WITH_LINE.exec(token)
    if (!parsed) continue
    let path = parsed[1]
    if (path.startsWith(rootPrefix)) path = path.slice(rootPrefix.length)
    else if (path.startsWith('./')) path = path.slice(2)
    if (!files.has(path)) continue
    const lineNumber = parsed[2] ? Number(parsed[2]) : undefined
    found.push({
      kind: 'file',
      start: m.index,
      end: m.index + token.length,
      path,
      ...(lineNumber ? { line: lineNumber } : {}),
    })
  }
  return found
}
