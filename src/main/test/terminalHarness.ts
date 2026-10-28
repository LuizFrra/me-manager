import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Terminal } from '@xterm/xterm'
import { joinShellWords } from '../../shared/shell'
import { parseTmuxTitle, type TmuxMode } from '../../shared/tmuxTitle'
import { SYSTEM_UNICODE } from '../../shared/unicodeWidths'
import { run } from '../exec'
import { ControlTerminal } from '../pty/controlTerminal'
import { spawnControl } from '../pty/spawnControl'
import type { TmuxService } from '../tmux/tmuxService'

/** The terminal's two ways of showing a session (Settings.terminalMode). */
export type TerminalEngine = 'classic' | 'direct'

/** Direct mode's scrollback, as TerminalView sets it. */
const DIRECT_SCROLLBACK = 20_000

/** xterm's mouse reporting (internal: TerminalView's DOM events reach it, a terminal never opened gets none). */
interface CoreMouse {
  triggerMouseEvent(e: CoreMouseEvent): boolean
}
/** A mouse event in xterm's terms: 0-based cell, button and action as xterm numbers them. */
type CoreMouseEvent = { col: number; row: number; x: number; y: number; button: number; action: number }
const LEFT = 0
const WHEEL = 4
const [UP, DOWN, MOVE] = [0, 1, 32]

/**
 * The app's terminal end to end, without Electron: a real xterm.js, set up as TerminalView sets it up, showing a
 * tmux session through one of the app's two engines, its replies going back the same way. Classic: a real tmux
 * client attached to the session (util-linux `script` gives it a terminal, as node-pty does in the app). Direct: a
 * real ControlTerminal (`tmux -C attach`) feeding xterm the shown pane's own output. Tests send it the bytes the app
 * would send (keys, mouse reports) and compare what xterm shows with what tmux holds. Linux only (`script` takes
 * other flags on macOS); needs a DOM (`@vitest-environment jsdom`) for xterm.
 */
export class TerminalHarness {
  readonly term: Terminal
  /** Everything written to xterm, decoded. */
  raw = ''
  /** Everything sent to the engine: keys, pastes, mouse reports and xterm's replies. */
  sent = ''
  /** The copy-mode state from tmux's last title (see TMUX_TITLE); always null in direct mode, which has no title. */
  mode: TmuxMode | null = null
  /** What the ControlTerminal warned about (direct mode). */
  readonly warnings: string[] = []
  private readonly decoder = new TextDecoder()
  private input: (data: string) => void = () => {}
  private stop: () => void = () => {}
  private resizeEngine: (cols: number, rows: number) => void = () => {
    throw new Error('Only the direct engine resizes')
  }

  private constructor(
    private readonly svc: TmuxService,
    private readonly socket: string,
    readonly session: string,
    readonly engine: TerminalEngine,
    cols: number,
    rows: number,
  ) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      ...(engine === 'direct' && { scrollback: DIRECT_SCROLLBACK }),
    })
    this.term.unicode.register(SYSTEM_UNICODE)
    this.term.unicode.activeVersion = SYSTEM_UNICODE.version
    if (engine === 'classic') this.term.onTitleChange((title) => (this.mode = parseTmuxTitle(title) ?? this.mode))
    // xterm's answers to queries, its pastes and mouse reports; onBinary has mouse reports in the old X10
    // encoding. TerminalView takes both the same way.
    this.term.onData((data) => this.send(data))
    this.term.onBinary((data) => this.send(data))
  }

  /** Attaches to `session` (already started on `svc`'s socket) with a `cols` x `rows` terminal. */
  static attach(
    engine: TerminalEngine,
    svc: TmuxService,
    socket: string,
    session: string,
    size: { cols?: number; rows?: number } = {},
  ): Promise<TerminalHarness> {
    return engine === 'classic'
      ? TerminalHarness.attachClassic(svc, socket, session, size)
      : TerminalHarness.attachDirect(svc, socket, session, size)
  }

  /** A tmux client in a terminal, whose screen xterm shows. */
  static async attachClassic(
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
    const harness = new TerminalHarness(svc, socket, session, 'classic', cols, rows)
    harness.input = (data) => client.stdin.write(data)
    harness.stop = () => client.kill()
    client.stdout.on('data', (chunk: Buffer) => {
      harness.raw += harness.decoder.decode(chunk, { stream: true })
      harness.term.write(new Uint8Array(chunk))
    })
    await harness.until(() => harness.mode !== null, 'the client to attach')
    return harness
  }

  /** A ControlTerminal, wired as the app wires it (index.ts), sized before it attaches as TerminalView does. */
  static async attachDirect(
    svc: TmuxService,
    socket: string,
    session: string,
    { cols = 80, rows = 24 } = {},
  ): Promise<TerminalHarness> {
    const harness = new TerminalHarness(svc, socket, session, 'direct', cols, rows)
    const warn = (msg: string): void => void harness.warnings.push(msg)
    const control = new ControlTerminal((s, cwd) => spawnControl(svc.controlCommand(s), cwd, warn), warn)
    control.onData((data) => {
      harness.raw += data
      harness.term.write(data)
    })
    harness.input = (data) => control.write(data)
    harness.stop = () => control.detach()
    harness.resizeEngine = (c, r) => control.resize(c, r)
    control.resize(cols, rows)
    control.attach(session, tmpdir())
    // Input before the first snapshot is dropped (there is no pane to send it to yet).
    await harness.until(() => harness.raw.includes('\x1bc'), 'the snapshot')
    await harness.flush()
    return harness
  }

  /** Resizes the terminal and tells the engine, as TerminalView does on a resize (direct mode only). */
  resize(cols: number, rows: number): void {
    this.resizeEngine(cols, rows)
    this.term.resize(cols, rows)
  }

  /** Sends bytes as the app's terminal does (keys, pastes, mouse reports). */
  send(data: string): void {
    this.sent += data
    this.input(data)
  }

  /**
   * A paste as xterm's own paste (term.paste, which needs a terminal opened in a page) sends it: newlines as CR,
   * between bracket markers when the terminal's bracketed paste mode is on.
   */
  paste(text: string): void {
    const data = text.replace(/\r?\n/g, '\r')
    this.send(this.term.modes.bracketedPasteMode ? `\x1b[200~${data}\x1b[201~` : data)
  }

  /** Resolves once xterm has parsed everything written to it so far. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve))
  }

  /**
   * A left-button drag along `row` from column `from` to `to` (0-based cells). Classic: reported as xterm reports
   * it, as tmux always asks for the mouse. Direct: tmux doesn't ask, the program in the pane may; xterm reports the
   * drag only if it did (in the encoding it asked for, the motion only if it asked for that), and otherwise makes
   * its own selection, which never involves tmux. `from === to` is a click.
   */
  async drag(row: number, from: number, to: number): Promise<void> {
    if (this.engine === 'direct') return this.directDrag(row, from, to)
    const at = (col: number): string => `${col + 1};${row + 1}`
    this.send(`\x1b[<0;${at(from)}M`)
    for (let col = from + 1; col <= to; col++) {
      await pause(20)
      this.send(`\x1b[<32;${at(col)}M`)
    }
    await pause(20)
    this.send(`\x1b[<0;${at(to)}m`)
  }

  private async directDrag(row: number, from: number, to: number): Promise<void> {
    const mouse = this.mouse()
    const event = (col: number, action: number): CoreMouseEvent => ({ col, row, x: 0, y: 0, button: LEFT, action })
    // Not reported: xterm selects on its own (not modelled here, it needs a terminal opened in a page).
    if (!mouse.triggerMouseEvent(event(from, DOWN))) return
    for (let col = from + 1; col <= to; col++) {
      await pause(20)
      mouse.triggerMouseEvent(event(col, MOVE))
    }
    await pause(20)
    mouse.triggerMouseEvent(event(to, UP))
  }

  /** One notch of the wheel, up (back into the history) or down. Direct: xterm's own scrolling, unless reported. */
  wheel(direction: 'up' | 'down'): void {
    if (this.engine === 'direct') {
      const action = direction === 'up' ? UP : DOWN
      if (!this.mouse().triggerMouseEvent({ col: 9, row: 4, x: 0, y: 0, button: WHEEL, action }))
        this.term.scrollLines(direction === 'up' ? -3 : 3)
      return
    }
    this.send(`\x1b[<${direction === 'up' ? 64 : 65};10;5M`)
  }

  private mouse(): CoreMouse {
    return (this.term as unknown as { _core: { coreMouseService: CoreMouse } })._core.coreMouseService
  }

  /** The rows xterm shows, without trailing blanks. */
  screen(): string[] {
    const buffer = this.term.buffer.active
    return Array.from({ length: this.term.rows }, (_, y) =>
      (buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').trimEnd(),
    )
  }

  /** Runs tmux on the test's socket. */
  tmux(...args: string[]): Promise<string> {
    return run('tmux', ['-L', this.socket, ...args])
  }

  /** The rows of the pane as tmux holds them, without trailing blanks. */
  async pane(): Promise<string[]> {
    const out = await this.tmux('capture-pane', '-p', '-t', `=${this.session}:`)
    return out
      .split('\n')
      .slice(0, this.term.rows)
      .map((line) => line.trimEnd())
  }

  /** A tmux format of the session's active pane. */
  async format(format: string): Promise<string> {
    return (await this.tmux('display-message', '-p', '-t', `=${this.session}:`, format)).trim()
  }

  /** Waits until xterm shows exactly what tmux holds, the cursor in the same cell (output has settled), or fails. */
  async showsPane(): Promise<void> {
    const cursor = (): string => `${this.term.buffer.active.cursorX},${this.term.buffer.active.cursorY}`
    let last = { screen: [] as string[], pane: [] as string[], cursor: '', paneCursor: '' }
    await this.until(async () => {
      const [pane, paneCursor] = await Promise.all([this.pane(), this.format('#{cursor_x},#{cursor_y}')])
      last = { screen: this.screen(), pane, cursor: cursor(), paneCursor }
      return last.screen.join('\n') === last.pane.join('\n') && last.cursor === last.paneCursor
    }, 'the screen to show the pane').catch(() => {
      throw new Error(
        `The screen differs from the pane.\nscreen (cursor ${last.cursor}):\n${last.screen.join('\n')}\n` +
          `pane (cursor ${last.paneCursor}):\n${last.pane.join('\n')}`,
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
    this.stop()
    this.term.dispose()
    await this.svc.killSession(this.session).catch(() => {})
  }
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
