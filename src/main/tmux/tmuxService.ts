import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TabInfo } from '../../shared/types'
import type { NewWindowOptions, SendTextOptions, TmuxApi, WindowActivity } from '../contracts'
import { CommandError, run, runTail, type RunOptions } from '../exec'
import { TMUX_CONF } from './tmuxConf'

/**
 * tmux format-expands the -c start directory: `#(cmd)` would run a shell command and
 * `#S` etc. would be replaced. `##` is a literal `#`, so escape every one.
 * (Session names are slugs and window names are fixed strings, so only cwd carries user input.)
 */
export function escapeFormat(value: string): string {
  return value.replace(/#/g, '##')
}

/**
 * A shell command as one tmux argument. tmux reads an argument that ends in `;` as the end of its own command (and
 * `\;` as a literal `;`), so a command ending in either would lose or change its end: a trailing space, which the
 * shell ignores, keeps it as typed.
 */
export const shellCommandArg = (command: string): string => (command.endsWith(';') ? `${command} ` : command)

const isNoServer = (err: unknown): boolean =>
  err instanceof CommandError && /no server running|error connecting/i.test(err.stderr)

/**
 * `list-windows -a -F '#{session_name}\t#{window_activity}\t#{window_name}'` output: the latest activity of the
 * windows named `windowName`, by session. The name comes last because it is the only field that could hold a tab.
 */
export function parseWindowActivity(out: string, windowName: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const [session, activity, ...name] = line.split('\t')
    const at = Number(activity)
    if (!session || name.join('\t') !== windowName || !Number.isFinite(at) || activity === '') continue
    result[session] = Math.max(result[session] ?? 0, at)
  }
  return result
}

/**
 * A pane capture as a transcript: each line without its trailing spaces (`-J` keeps them, and full-screen apps pad
 * with them), without the blank lines below the last output (the rest of the screen), and ending with one
 * newline; '' when nothing is left.
 */
export function tidyCapture(text: string): string {
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** sendText waits this long between the text and Enter, so the app reads Enter as a key press, not pasted text. */
export const SEND_ENTER_DELAY_MS = 150
/** Every tmux call gives up after this long: a wedged server must not hang the app's calls (and its polls). */
export const TMUX_TIMEOUT_MS = 10_000

export interface TmuxServiceOptions {
  /** Overrides SEND_ENTER_DELAY_MS (for tests). */
  enterDelayMs?: number
  /** Overrides TMUX_TIMEOUT_MS (for tests). */
  timeoutMs?: number
}

export class TmuxService implements TmuxApi {
  private readonly enterDelayMs: number
  private readonly timeoutMs: number

  constructor(
    private readonly socket: string,
    private readonly configFile: string,
    options: TmuxServiceOptions = {},
  ) {
    this.enterDelayMs = options.enterDelayMs ?? SEND_ENTER_DELAY_MS
    this.timeoutMs = options.timeoutMs ?? TMUX_TIMEOUT_MS
  }

  /**
   * Writes the config, and applies it to a server that is already running: `-f` is read only when the server
   * starts, and sessions outlive the app, so a new version's settings would otherwise wait for the next reboot.
   */
  async ensureConfig(): Promise<void> {
    await mkdir(dirname(this.configFile), { recursive: true })
    await writeFile(this.configFile, TMUX_CONF, 'utf8')
    try {
      await this.tmux(['source-file', this.configFile])
    } catch (err) {
      if (!isNoServer(err)) throw err
    }
  }

  private baseArgs(): string[] {
    return ['-L', this.socket, '-f', this.configFile]
  }

  private tmux(args: string[], opts: Pick<RunOptions, 'input'> = {}): Promise<string> {
    return run('tmux', [...this.baseArgs(), ...args], { ...opts, timeoutMs: this.timeoutMs })
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', `=${name}`])
      return true
    } catch (err) {
      if (err instanceof CommandError) return false
      throw err
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const out = await this.tmux(['list-sessions', '-F', '#{session_name}'])
      return out.split('\n').filter(Boolean)
    } catch (err) {
      if (isNoServer(err)) return []
      throw err
    }
  }

  async windowActivity(windowName: string): Promise<Record<string, number>> {
    let out: string
    try {
      out = await this.tmux(['list-windows', '-a', '-F', '#{session_name}\t#{window_activity}\t#{window_name}'])
    } catch (err) {
      if (isNoServer(err)) return {}
      throw err
    }
    return parseWindowActivity(out, windowName)
  }

  async capturePane(session: string, windowName: string): Promise<string | null> {
    try {
      // `=` on both parts: exact session and window names, never a prefix or pattern match.
      return await this.tmux(['capture-pane', '-p', '-t', `=${session}:=${windowName}`])
    } catch (err) {
      if (err instanceof CommandError) return null
      throw err
    }
  }

  async captureHistory(
    session: string,
    index: number,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean }> {
    // By window id (`@3`), never `=session:index`: tmux falls back to matching window *names* (`9` or `9…`) when
    // there is no window at that index.
    const out = await this.tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_index}\t#{window_id}'])
    const id = out
      .split('\n')
      .map((line) => line.split('\t'))
      .find(([i]) => i === String(index))?.[1]
    if (!id || !/^@\d+$/.test(id)) throw new Error(`No tab ${index} in ${session}`)
    // -J joins wrapped lines; without -e there are no escape sequences; -S - -E -: the whole history and screen.
    const { stdout, truncated } = await runTail(
      'tmux',
      [...this.baseArgs(), 'capture-pane', '-p', '-J', '-S', '-', '-E', '-', '-t', id],
      maxBytes,
      { timeoutMs: this.timeoutMs },
    )
    return { text: tidyCapture(stdout), truncated }
  }

  /** In copy mode (the user scrolled back) tmux, not the app, would get keys and pastes: leaves it first. */
  private async leaveMode(target: string): Promise<void> {
    const inMode = (await this.tmux(['display-message', '-p', '-t', target, '#{pane_in_mode}'])).trim()
    // (Other modes, like choose-tree, may not take `cancel`; the keys still go to the app then.)
    if (inMode !== '0') await this.tmux(['send-keys', '-t', target, '-X', 'cancel']).catch(() => {})
  }

  async sendText(session: string, windowName: string, text: string, options: SendTextOptions = {}): Promise<void> {
    // `=` on both parts: exact names, never a prefix or pattern match.
    const target = `=${session}:=${windowName}`
    await this.leaveMode(target)
    // Through a paste buffer read from stdin, not `send-keys -l`: tmux refuses a command over ~16 KB, and the text
    // is never parsed as tmux syntax (`;`, key names). -p: as a bracketed paste when the app asked for those, so
    // it is read as text, never as keys; -d: the buffer is deleted once pasted.
    const buffer = `me-manager-${randomUUID()}`
    await this.tmux(['load-buffer', '-b', buffer, '-'], { input: text })
    try {
      await this.tmux(['paste-buffer', '-d', '-p', '-b', buffer, '-t', target])
    } catch (err) {
      await this.tmux(['delete-buffer', '-b', buffer]).catch(() => {})
      throw err
    }
    if (options.enter === false) return
    await new Promise((r) => setTimeout(r, this.enterDelayMs))
    await this.tmux(['send-keys', '-t', target, 'Enter'])
  }

  async newSession(name: string, cwd: string, windowName: string, command: string): Promise<void> {
    await this.tmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      escapeFormat(cwd),
      '-n',
      windowName,
      shellCommandArg(command),
    ])
  }

  async killSession(name: string): Promise<void> {
    if (await this.hasSession(name)) await this.tmux(['kill-session', '-t', `=${name}`])
  }

  async listWindows(session: string): Promise<TabInfo[]> {
    // The name last: it is the only field that could hold a tab. Pane formats are the window's active pane.
    const out = await this.tmux([
      'list-windows',
      '-t',
      `=${session}`,
      '-F',
      '#{window_index}\t#{window_active}\t#{pane_dead}\t#{window_name}',
    ])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [index, active, dead, ...name] = line.split('\t')
        const tab: TabInfo = { index: Number(index), name: name.join('\t'), active: active === '1' }
        if (dead === '1') tab.dead = true
        return tab
      })
  }

  async newWindow(
    session: string,
    cwd: string,
    windowName: string,
    command?: string,
    options: NewWindowOptions = {},
  ): Promise<void> {
    await this.tmux([
      'new-window',
      '-t',
      `=${session}:`,
      '-c',
      escapeFormat(cwd),
      '-n',
      windowName,
      ...(command ? [shellCommandArg(command)] : []),
      // In the same tmux call, so it is set before a command that exits at once is reaped: tmux runs a call's
      // commands in one go. The new window is the session's current one (`=session:`), as it was not made with -d.
      ...(options.remainOnExit ? [';', 'set-option', '-w', '-t', `=${session}:`, 'remain-on-exit', 'on'] : []),
    ])
  }

  async respawnWindow(session: string, windowName: string, cwd: string, command: string): Promise<void> {
    await this.tmux([
      'respawn-window',
      '-k',
      '-t',
      `=${session}:=${windowName}`,
      '-c',
      escapeFormat(cwd),
      shellCommandArg(command),
    ])
  }

  async sendInterrupt(session: string, windowName: string): Promise<void> {
    const target = `=${session}:=${windowName}`
    await this.leaveMode(target)
    await this.tmux(['send-keys', '-t', target, 'C-c'])
  }

  async listWindowActivity(session: string): Promise<WindowActivity[]> {
    let out: string
    try {
      out = await this.tmux([
        'list-windows',
        '-t',
        `=${session}`,
        '-F',
        '#{window_index}\t#{window_id}\t#{window_activity}\t#{window_name}',
      ])
    } catch (err) {
      if (err instanceof CommandError) return [] // no such session, or no server
      throw err
    }
    const windows: WindowActivity[] = []
    for (const line of out.split('\n')) {
      const [index, id, activity, ...name] = line.split('\t')
      if (!/^\d+$/.test(index ?? '') || !/^@\d+$/.test(id ?? '') || !/^\d+$/.test(activity ?? '')) continue
      windows.push({ index: Number(index), id, name: name.join('\t'), activity: Number(activity) })
    }
    return windows
  }

  async captureTail(windowId: string, lines: number): Promise<string | null> {
    if (!/^@\d+$/.test(windowId)) throw new Error(`Invalid window id: ${windowId}`)
    const start = `-${Math.max(0, Math.floor(lines))}`
    try {
      // -J joins wrapped lines, so a long URL stays one line; without -e there are no escape sequences.
      return await this.tmux(['capture-pane', '-p', '-J', '-S', start, '-t', windowId])
    } catch (err) {
      if (err instanceof CommandError) return null
      throw err
    }
  }

  async selectWindow(session: string, index: number): Promise<void> {
    await this.tmux(['select-window', '-t', `=${session}:${index}`])
  }

  async killWindow(session: string, index: number): Promise<void> {
    await this.tmux(['kill-window', '-t', `=${session}:${index}`])
  }

  attachCommand(session: string): { file: string; args: string[] } {
    return { file: 'tmux', args: [...this.baseArgs(), '-u', 'attach-session', '-t', `=${session}`] }
  }
}
