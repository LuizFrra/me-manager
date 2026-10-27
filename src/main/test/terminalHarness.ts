import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { Terminal } from '@xterm/xterm'
import { joinShellWords } from '../../shared/shell'
import { parseTmuxTitle, type TmuxMode } from '../../shared/tmuxTitle'
import { SYSTEM_UNICODE } from '../../shared/unicodeWidths'
import { run } from '../exec'
import type { TmuxService } from '../tmux/tmuxService'

/**
 * The app's terminal end to end, without Electron: a real tmux client attached to a session (util-linux `script`
 * gives it a terminal, as node-pty does in the app) whose output goes to a real xterm.js, set up as TerminalView sets
 * it up, and whose replies go back to tmux. Tests send it the bytes the app would send (keys, mouse reports) and
 * compare what xterm shows with what tmux holds. Linux only (`script` takes other flags on macOS); needs a DOM
 * (`@vitest-environment jsdom`) for xterm.
 */
export class TerminalHarness {
  readonly term: Terminal
  /** Everything tmux sent the client, decoded. */
  raw = ''
  /** The copy-mode state from tmux's last title (see TMUX_TITLE). */
  mode: TmuxMode | null = null
  private readonly decoder = new TextDecoder()

  private constructor(
    private readonly svc: TmuxService,
    private readonly socket: string,
    readonly session: string,
    private readonly client: ChildProcessByStdio<Writable, Readable, null>,
    cols: number,
    rows: number,
  ) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true })
    this.term.unicode.register(SYSTEM_UNICODE)
    this.term.unicode.activeVersion = SYSTEM_UNICODE.version
    this.term.onTitleChange((title) => (this.mode = parseTmuxTitle(title) ?? this.mode))
    this.term.onData((data) => client.stdin.write(data)) // xterm's answers to tmux's queries, as in the app
    client.stdout.on('data', (chunk: Buffer) => {
      this.raw += this.decoder.decode(chunk, { stream: true })
      this.term.write(new Uint8Array(chunk))
    })
  }

  /** Attaches to `session` (already started on `svc`'s socket) with a `cols` x `rows` terminal. */
  static async attach(
    svc: TmuxService,
    socket: string,
    session: string,
    { cols = 80, rows = 24 } = {},
  ): Promise<TerminalHarness> {
    const { file, args } = svc.attachCommand(session)
    const command = `stty cols ${cols} rows ${rows}; exec ${joinShellWords([file, ...args])}`
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' }
    delete env.TMUX
    const client = spawn('script', ['-qfec', command, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const harness = new TerminalHarness(svc, socket, session, client, cols, rows)
    await harness.until(() => harness.mode !== null, 'the client to attach')
    return harness
  }

  /** Sends bytes as the app's terminal does (keys, pastes, mouse reports). */
  send(data: string): void {
    this.client.stdin.write(data)
  }

  /** A left-button drag along `row` from column `from` to `to` (0-based cells), reported as xterm reports it. */
  async drag(row: number, from: number, to: number): Promise<void> {
    const at = (col: number): string => `${col + 1};${row + 1}`
    this.send(`\x1b[<0;${at(from)}M`)
    for (let col = from + 1; col <= to; col++) {
      await pause(20)
      this.send(`\x1b[<32;${at(col)}M`)
    }
    await pause(20)
    this.send(`\x1b[<0;${at(to)}m`)
  }

  /** One notch of the wheel, up (back into the history) or down. */
  wheel(direction: 'up' | 'down'): void {
    this.send(`\x1b[<${direction === 'up' ? 64 : 65};10;5M`)
  }

  /** The rows xterm shows, without trailing blanks. */
  screen(): string[] {
    const buffer = this.term.buffer.active
    return Array.from({ length: this.term.rows }, (_, y) =>
      (buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').trimEnd(),
    )
  }

  /** The rows of the pane as tmux holds them, without trailing blanks. */
  async pane(): Promise<string[]> {
    const out = await run('tmux', ['-L', this.socket, 'capture-pane', '-p', '-t', `=${this.session}:`])
    return out
      .split('\n')
      .slice(0, this.term.rows)
      .map((line) => line.trimEnd())
  }

  /** Waits until xterm shows exactly what tmux holds (output has settled), or fails with both. */
  async showsPane(): Promise<void> {
    let last: { screen: string[]; pane: string[] } = { screen: [], pane: [] }
    await this.until(async () => {
      last = { screen: this.screen(), pane: await this.pane() }
      return last.screen.join('\n') === last.pane.join('\n')
    }, 'the screen to show the pane').catch(() => {
      throw new Error(
        `The screen differs from the pane.\nscreen:\n${last.screen.join('\n')}\npane:\n${last.pane.join('\n')}`,
      )
    })
  }

  /** Polls `check` until it holds, for up to `ms`. */
  async until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
      await pause(25)
    }
  }

  async close(): Promise<void> {
    this.client.kill()
    this.term.dispose()
    await this.svc.killSession(this.session).catch(() => {})
  }
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
