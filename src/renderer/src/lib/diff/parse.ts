export type DiffLineKind = 'context' | 'add' | 'del' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface ParsedDiff {
  binary: boolean
  oldPath?: string
  newPath?: string
  renamed: boolean
  hunks: DiffHunk[]
  lineCount: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Decodes a C-style quoted path as written by git (core.quotePath), e.g. "t\303\251st". */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = String.fromCodePoint(body.codePointAt(i) ?? 0)
    if (ch !== '\\' || i + 1 >= body.length) {
      bytes.push(...encoder.encode(ch))
      i += ch.length - 1
      continue
    }
    const next = body[i + 1]
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += 3
    } else if (Object.hasOwn(ESCAPES, next)) {
      bytes.push(ESCAPES[next])
      i += 1
    } else {
      bytes.push(...encoder.encode(ch))
    }
  }
  return decoder.decode(new Uint8Array(bytes))
}

/** Parses a `---`/`+++` path: strips git's trailing tab, the a/ or b/ prefix, and maps /dev/null to undefined. */
function headerPath(raw: string, prefix: 'a/' | 'b/'): string | undefined {
  const tab = raw.indexOf('\t')
  const value = unquote(tab === -1 ? raw : raw.slice(0, tab))
  if (value === '/dev/null') return undefined
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

/** Parses the unified diff text for a single file, as produced by `git diff`. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { binary: false, renamed: false, hunks: [], lineCount: 0 }
  let hunk: DiffHunk | undefined
  let oldNo = 0
  let newNo = 0
  // Lines still expected in the current hunk, per side. While either is positive,
  // lines are hunk content even if they look like `---`/`+++` headers.
  let oldLeft = 0
  let newLeft = 0

  for (const line of text.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      hunk = { header: line, lines: [] }
      result.hunks.push(hunk)
      oldNo = Number(header[1])
      newNo = Number(header[3])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      continue
    }

    if (hunk && line.startsWith('\\')) {
      hunk.lines.push({ kind: 'note', text: line })
      continue
    }

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const body = line.slice(1)
      // git with diff.suppressBlankEmpty writes an empty context line as '' instead of ' '.
      if (line.startsWith(' ') || (line === '' && oldLeft > 0 && newLeft > 0)) {
        hunk.lines.push({ kind: 'context', text: body, oldNo: oldNo++, newNo: newNo++ })
        oldLeft--
        newLeft--
      } else if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'del', text: body, oldNo: oldNo++ })
        oldLeft--
      } else if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'add', text: body, newNo: newNo++ })
        newLeft--
      }
      continue
    }

    // Outside a hunk: file header lines.
    if (line.startsWith('--- ')) result.oldPath = headerPath(line.slice(4), 'a/')
    else if (line.startsWith('+++ ')) result.newPath = headerPath(line.slice(4), 'b/')
    else if (line.startsWith('rename from ')) {
      result.renamed = true
      result.oldPath = unquote(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      result.renamed = true
      result.newPath = unquote(line.slice('rename to '.length))
    } else if ((line.startsWith('Binary files ') && line.endsWith(' differ')) || line === 'GIT binary patch') {
      result.binary = true
    }
  }

  result.lineCount = result.hunks.reduce((n, h) => n + h.lines.length, 0)
  return result
}
