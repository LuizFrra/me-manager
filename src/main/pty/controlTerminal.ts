import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { PtyApi } from '../contracts'
import { inputCommands } from './controlInput'
import { ControlParser, type ControlEvent } from './controlProtocol'
import { leaveModeCommand, parseSnapshot, SNAPSHOT_REPLIES, snapshotCommand, snapshotData } from './snapshot'
import { isTermSize } from './termSize'

/** A `tmux -C attach` process, talking over pipes. */
export interface ControlProcess {
  stdin: Writable
  stdout: Readable
  kill(): void
  on(event: 'exit', cb: () => void): void
}

export type SpawnControl = (session: string, cwd: string) => ControlProcess

type Reply = Extract<ControlEvent, { kind: 'reply' }>

/**
 * A line written and not fully answered yet. tmux answers each command on a line with a reply, but when one fails it
 * sends one %error and skips the rest of the line (as for a line it can't parse), so `done` gets the replies that
 * came: all `expected` of them, or fewer, the last one failed.
 */
interface PendingLine {
  expected: number
  replies: Reply[]
  done: (replies: Reply[]) => void
}

/** One control client and what it is doing. */
interface Client {
  proc: ControlProcess
  session: string
  parser: ControlParser
  /** Decodes the shown pane's output; a UTF-8 character may be cut between two %output lines. */
  decoder: StringDecoder
  /** The lines written and not answered yet, oldest first. */
  pending: PendingLine[]
  /** The pane shown (its output goes to the terminal), none until a snapshot came in. */
  pane: string | null
  /** The session's id ('$1'), from a snapshot shown; none until one was. */
  sessionId: string | null
  /** The session's current window ('@2'): from the last snapshot shown, or the session's last window change. */
  window: string | null
  /** The latest snapshot asked for; an older one's result is stale. */
  generation: number
  /** A snapshot is on its way: the pane's output until then is in it. */
  snapshotting: boolean
  /** What this stdout chunk has to show, emitted once the chunk is read. */
  out: string
  /** tmux said %exit while reading this chunk. */
  exiting: boolean
}

/** What the terminal shows when a pane can't be shown. */
const notice = (why: string): string => `\x1bc\x1b[2m[could not show this tab: ${why}]\x1b[0m\r\n`

/**
 * Shows a tmux session through a control client (`tmux -C attach`): a snapshot of its active pane, then that
 * pane's output, and a new snapshot whenever the active window or pane changes. Input goes to the pane as tmux
 * commands. Never throws on what tmux says or on a broken pipe.
 */
export class ControlTerminal implements PtyApi {
  private client: Client | null = null
  private cols = 120
  private rows = 30
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(
    private readonly spawn: SpawnControl,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  attach(session: string, cwd: string): void {
    this.detach()
    const proc = this.spawn(session, cwd)
    const client: Client = {
      proc,
      session,
      parser: new ControlParser((e) => this.event(client, e), this.warn),
      decoder: new StringDecoder('utf8'),
      pending: [],
      pane: null,
      sessionId: null,
      window: null,
      generation: 0,
      snapshotting: false,
      out: '',
      exiting: false,
    }
    this.client = client
    // A write to a client that went away fails with EPIPE, as an 'error' event; without a listener it would throw.
    proc.stdin.on('error', (err) => {
      if (this.client === client) this.warn(`tmux control mode: ${String(err)}`)
    })
    proc.stdout.on('data', (chunk: Buffer) => this.chunk(client, chunk))
    proc.on('exit', () => this.exit(client))
    this.send(client, `refresh-client -C ${this.cols}x${this.rows}`, 1, this.checked('refresh-client'))
    this.snapshot(client)
  }

  detach(): void {
    const client = this.client
    this.client = null
    client?.proc.kill()
  }

  write(data: string): void {
    const client = this.client
    if (!client) return
    // Until a snapshot says which pane is shown, keys go to the session's active pane, the one it will show.
    let cmds: string[]
    try {
      cmds = inputCommands(client.pane ?? `=${client.session}:`, data)
    } catch (err) {
      return this.warn(`tmux control mode: ${String(err)}`)
    }
    for (const cmd of cmds) this.send(client, cmd, 1, this.checked('input'))
  }

  resize(cols: number, rows: number): void {
    if (!isTermSize(cols) || !isTermSize(rows)) return
    this.cols = cols
    this.rows = rows
    if (this.client) this.send(this.client, `refresh-client -C ${cols}x${rows}`, 1, this.checked('refresh-client'))
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  /** Reads one stdout chunk, then shows what it had in one go (one IPC message rather than one per line). */
  private chunk(client: Client, chunk: Buffer): void {
    if (this.client !== client) return
    client.parser.feed(chunk)
    const out = client.out
    client.out = ''
    if (out && this.client === client) this.dataListeners.forEach((cb) => cb(out))
    if (client.exiting) this.exit(client)
  }

  private event(client: Client, e: ControlEvent): void {
    if (this.client !== client) return
    switch (e.kind) {
      case 'output':
        // While a snapshot is on its way, the output is in it.
        if (e.pane === client.pane && !client.snapshotting) client.out += client.decoder.write(e.data)
        return
      case 'reply': {
        if (!e.ours) return // the attach's own block
        const line = client.pending[0]
        if (!line) return this.warn(`tmux control mode: a reply to nothing: ${JSON.stringify(e.lines[0] ?? '')}`)
        line.replies.push(e)
        // A failure ends the line: tmux skips the rest of its commands.
        if (e.ok && line.replies.length < line.expected) return
        client.pending.shift()
        return line.done(line.replies)
      }
      // tmux tells every control client about every session's window changes and every window's pane changes; a
      // new snapshot resets the terminal (scroll position, selection), so only ours take one. Before a snapshot
      // said which session and window are ours, any change may be: one more snapshot is harmless then.
      case 'window-changed':
        if (client.sessionId !== null && e.session !== client.sessionId) return
        client.window = e.window
        return this.snapshot(client)
      case 'pane-changed':
        if (client.window !== null && e.window !== client.window) return
        return this.snapshot(client)
      case 'exit':
        client.exiting = true
        return
    }
  }

  /**
   * Asks for a snapshot of the session's active pane, which replaces whatever the terminal shows. The pane leaves
   * any mode first, so typed keys reach its program; on a line of its own, so its failure doesn't stop the snapshot.
   */
  private snapshot(client: Client): void {
    let leave: string
    let cmd: string
    try {
      leave = leaveModeCommand(`=${client.session}:`)
      cmd = snapshotCommand(`=${client.session}:`)
    } catch (err) {
      client.out += notice(String(err))
      return
    }
    this.send(client, leave, 1, this.checked('leaving the mode'))
    const generation = ++client.generation
    client.snapshotting = true
    this.send(client, cmd, SNAPSHOT_REPLIES, (replies) => {
      // A stale snapshot's replies are still read off the queue; only the latest one is shown.
      if (generation !== client.generation) return
      client.snapshotting = false
      const failed = replies.find((reply) => !reply.ok)
      const snapshot = failed ? null : parseSnapshot(replies.map((reply) => reply.lines))
      if (!snapshot) {
        // The previous pane, if any, stays shown: its output flows again.
        client.out += notice(failed ? (failed.lines[0] ?? 'tmux refused') : 'tmux sent a malformed pane state')
        return
      }
      client.pane = snapshot.state.pane
      client.sessionId = snapshot.state.session
      client.window = snapshot.state.window
      client.decoder = new StringDecoder('utf8')
      client.out += snapshotData(snapshot)
    })
  }

  /** A line's `done` that only warns when a command failed. */
  private checked(what: string): (replies: Reply[]) => void {
    return (replies) => {
      const failed = replies.find((r) => !r.ok)
      if (failed) this.warn(`tmux control mode: ${what} failed: ${failed.lines.join(' ')}`)
    }
  }

  /** Writes one input line of `expected` commands; `done` takes their replies once the line is answered. */
  private send(client: Client, line: string, expected: number, done: (replies: Reply[]) => void): void {
    const { stdin } = client.proc
    if (stdin.destroyed || !stdin.writable) return
    try {
      stdin.write(`${line}\n`)
      client.pending.push({ expected, replies: [], done })
    } catch (err) {
      this.warn(`tmux control mode: ${String(err)}`)
    }
  }

  private exit(client: Client): void {
    if (this.client !== client) return
    this.client = null
    this.exitListeners.forEach((cb) => cb(0))
  }
}
