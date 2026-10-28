/** What a tmux control client (`tmux -C attach`) tells us, as far as the app cares. */
export type ControlEvent =
  /** Bytes a pane printed (pane like '%3'), already decoded. */
  | { kind: 'output'; pane: string; data: Buffer }
  /** A `%begin`…`%end`/`%error` block; `ours` when this client sent the command (flags & 1). */
  | { kind: 'reply'; ok: boolean; lines: string[]; ours: boolean }
  /** `%session-window-changed $s @w`: the session's current window is now '@w'. */
  | { kind: 'window-changed'; window: string }
  /** `%window-pane-changed @w %p`: the window's active pane is now '%p'. */
  | { kind: 'pane-changed'; window: string; pane: string }
  /** `%exit [reason]`: the client is leaving; the reason may be ''. */
  | { kind: 'exit'; reason: string }

const NL = 0x0a
const CR = 0x0d
const BACKSLASH = 0x5c
const SPACE = 0x20
const ZERO = 0x30
const OUTPUT = Buffer.from('%output ')
const END = Buffer.from('%end ')
const ERROR = Buffer.from('%error ')
/** Lines longer than this are cut in warnings. */
const WARN_MAX = 200

const startsWith = (buf: Buffer, prefix: Buffer): boolean =>
  buf.length >= prefix.length && buf.compare(prefix, 0, prefix.length, 0, prefix.length) === 0

const isOctal = (c: number | undefined): c is number => c !== undefined && c >= ZERO && c <= ZERO + 7

/**
 * Decodes a `%output` payload: tmux escapes bytes below 0x20 and the backslash as `\ooo` and sends the rest raw.
 * Anything that isn't a valid escape is kept as is. Copies slices between backslashes, as this is the hot path.
 */
export function decodeOutput(escaped: Buffer): Buffer {
  let bs = escaped.indexOf(BACKSLASH)
  if (bs === -1) return escaped
  const out = Buffer.allocUnsafe(escaped.length)
  let n = 0
  let from = 0
  while (bs !== -1) {
    const a = escaped[bs + 1]
    const b = escaped[bs + 2]
    const c = escaped[bs + 3]
    if (isOctal(a) && isOctal(b) && isOctal(c) && a <= ZERO + 3) {
      n += escaped.copy(out, n, from, bs)
      out[n++] = (a - ZERO) * 64 + (b - ZERO) * 8 + (c - ZERO)
      from = bs + 4
      bs = escaped.indexOf(BACKSLASH, from)
    } else {
      bs = escaped.indexOf(BACKSLASH, bs + 1)
    }
  }
  n += escaped.copy(out, n, from)
  return out.subarray(0, n)
}

/** A reply block being read; `guard` is its `%begin` line's `<time> <number> <flags>`. */
interface Block {
  guard: string
  ours: boolean
  lines: string[]
}

/** Feeds raw stdout chunks; calls `emit` for each complete event. Never throws on bad input (warns and skips). */
export class ControlParser {
  /** The pieces of a line whose `\n` hasn't arrived yet. */
  private partial: Buffer[] = []
  /** The reply block being read: every line is its text until the `%end`/`%error` with the same guard. */
  private block: Block | null = null

  constructor(
    private readonly emit: (e: ControlEvent) => void,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  feed(chunk: Buffer): void {
    // Split on bytes, not strings: a UTF-8 character in %output may be cut between chunks.
    let start = 0
    let nl = chunk.indexOf(NL)
    while (nl !== -1) {
      let line = chunk.subarray(start, nl)
      if (this.partial.length > 0) {
        this.partial.push(line)
        line = Buffer.concat(this.partial)
        this.partial = []
      }
      this.line(line)
      start = nl + 1
      nl = chunk.indexOf(NL, start)
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start))
  }

  private line(raw: Buffer): void {
    // tmux ends lines with \n alone, and a payload's \r is escaped; strip one anyway so CRLF parses too.
    const line = raw[raw.length - 1] === CR ? raw.subarray(0, -1) : raw
    if (this.block) return this.blockLine(this.block, line)
    if (startsWith(line, OUTPUT)) return this.output(line)
    const text = line.toString('utf8')
    if (!text.startsWith('%')) return this.bad('not a notification', text)
    const words = text.split(' ')
    switch (words[0]) {
      case '%begin': {
        const guard = words.slice(1)
        if (guard.length !== 3 || !guard.every((w) => /^\d+$/.test(w))) return this.bad('malformed', text)
        this.block = { guard: guard.join(' '), ours: (Number(guard[2]) & 1) === 1, lines: [] }
        return
      }
      case '%session-window-changed': {
        const window = words[2]
        if (!window?.startsWith('@')) return this.bad('malformed', text)
        return this.emit({ kind: 'window-changed', window })
      }
      case '%window-pane-changed': {
        const [, window, pane] = words
        if (!window?.startsWith('@') || !pane?.startsWith('%')) return this.bad('malformed', text)
        return this.emit({ kind: 'pane-changed', window, pane })
      }
      case '%exit':
        return this.emit({ kind: 'exit', reason: text.slice('%exit '.length) })
      case '%output':
      case '%end':
      case '%error':
        return this.bad('malformed', text) // a good %output was handled above; the others belong in a block
      default:
        return // a notification we don't use
    }
  }

  private blockLine(block: Block, line: Buffer): void {
    const ok = startsWith(line, END)
    if (ok || startsWith(line, ERROR)) {
      // Only the guard with this block's time, number and flags ends it; any other line, even a lookalike (a
      // capture of a pane that printed one), is reply text.
      if (line.toString('latin1', (ok ? END : ERROR).length) === block.guard) {
        this.block = null
        return this.emit({ kind: 'reply', ok, lines: block.lines, ours: block.ours })
      }
    }
    block.lines.push(line.toString('utf8'))
  }

  /** `%output %<pane> <payload>`: the payload stays bytes until decoded. */
  private output(line: Buffer): void {
    const sp = line.indexOf(SPACE, OUTPUT.length)
    const pane = line.toString('latin1', OUTPUT.length, sp === -1 ? line.length : sp)
    if (!/^%\d+$/.test(pane)) return this.bad('malformed', line.toString('utf8'))
    const payload = sp === -1 ? Buffer.alloc(0) : line.subarray(sp + 1)
    this.emit({ kind: 'output', pane, data: decodeOutput(payload) })
  }

  private bad(why: string, text: string): void {
    const shown = text.length > WARN_MAX ? `${text.slice(0, WARN_MAX)}…` : text
    this.warn(`tmux control mode: ${why} line: ${JSON.stringify(shown)}`)
  }
}
