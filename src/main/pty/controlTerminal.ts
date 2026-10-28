import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { inputCommands } from './controlInput'
import { ControlParser, type ControlEvent } from './controlProtocol'
import { parseSnapshot, SNAPSHOT_REPLIES, snapshotCommand, snapshotData } from './snapshot'
import { isTermSize } from './termSize'

/** A terminal showing a tmux session's active pane. */
export interface SessionTerminal {
  /** Starts showing `session`, replacing (killing) any previous one. */
  attach(session: string, cwd: string): void
  /** Stops showing the current session without emitting exit. */
  detach(): void
  write(data: string): void
  /** Remembers the size and resizes the current client, if any. */
  resize(cols: number, rows: number): void
  onData(cb: (data: string) => void): () => void
  onExit(cb: (code: number) => void): () => void
}

/** A `tmux -C attach` process, talking over pipes. */
export interface ControlProcess {
  stdin: Writable
  stdout: Readable
  kill(): void
  on(event: 'exit', cb: () => void): void
}

export type SpawnControl = (session: string, cwd: string) => ControlProcess

type Reply = Extract<ControlEvent, { kind: 'reply' }>

/** One control client and what it is doing. */
interface Client {
  proc: ControlProcess
  session: string
  parser: ControlParser
  /** Decodes the shown pane's output; a UTF-8 character may be cut between two %output lines. */
  decoder: StringDecoder
  /** What to do with the reply to each command written and not answered yet, oldest first. */
  pending: ((r: Reply) => void)[]
  /** The pane shown (its output goes to the terminal), none until a snapshot came in. */
  pane: string | null
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
export class ControlTerminal implements SessionTerminal {
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
    this.send(client, `refresh-client -C ${this.cols}x${this.rows}`, [this.checked('refresh-client')])
    this.snapshot(client)
  }

  detach(): void {
    const client = this.client
    this.client = null
    client?.proc.kill()
  }

  write(data: string): void {
    const client = this.client
    if (!client?.pane) return
    for (const cmd of inputCommands(client.pane, data)) this.send(client, cmd, [this.checked('input')])
  }

  resize(cols: number, rows: number): void {
    if (!isTermSize(cols) || !isTermSize(rows)) return
    this.cols = cols
    this.rows = rows
    if (this.client) this.send(this.client, `refresh-client -C ${cols}x${rows}`, [this.checked('refresh-client')])
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
        const handle = client.pending.shift()
        if (handle) handle(e)
        else this.warn(`tmux control mode: a reply to nothing: ${JSON.stringify(e.lines[0] ?? '')}`)
        return
      }
      case 'window-changed':
      case 'pane-changed':
        return this.snapshot(client)
      case 'exit':
        client.exiting = true
        return
    }
  }

  /** Asks for a snapshot of the session's active pane, which replaces whatever the terminal shows. */
  private snapshot(client: Client): void {
    let cmd: string
    try {
      cmd = snapshotCommand(`=${client.session}:`)
    } catch (err) {
      client.out += notice(String(err))
      return
    }
    const generation = ++client.generation
    client.snapshotting = true
    const replies: Reply[] = []
    const collect = (r: Reply): void => {
      replies.push(r)
      // A stale snapshot's replies are still read off the queue; only the latest one is shown.
      if (replies.length < SNAPSHOT_REPLIES || generation !== client.generation) return
      client.snapshotting = false
      const failed = replies.find((reply) => !reply.ok)
      const snapshot = failed ? null : parseSnapshot(replies.map((reply) => reply.lines))
      if (!snapshot) {
        client.out += notice(failed ? (failed.lines[0] ?? 'tmux refused') : 'tmux sent a malformed pane state')
        return
      }
      client.pane = snapshot.state.pane
      client.decoder = new StringDecoder('utf8')
      client.out += snapshotData(snapshot)
    }
    this.send(
      client,
      cmd,
      Array.from({ length: SNAPSHOT_REPLIES }, () => collect),
    )
  }

  /** A reply handler that only warns when the command failed. */
  private checked(what: string): (r: Reply) => void {
    return (r) => {
      if (!r.ok) this.warn(`tmux control mode: ${what} failed: ${r.lines.join(' ')}`)
    }
  }

  /** Writes one input line; `handlers` take its replies, one per command on the line. */
  private send(client: Client, line: string, handlers: ((r: Reply) => void)[]): void {
    const { stdin } = client.proc
    if (stdin.destroyed || !stdin.writable) return
    try {
      stdin.write(`${line}\n`)
      client.pending.push(...handlers)
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
