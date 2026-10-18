import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TabInfo } from '../../shared/types'
import type { TmuxApi } from '../contracts'
import { CommandError, run } from '../exec'
import { TMUX_CONF } from './tmuxConf'

/**
 * tmux format-expands the -c start directory: `#(cmd)` would run a shell command and
 * `#S` etc. would be replaced. `##` is a literal `#`, so escape every one.
 * (Session names are slugs and window names are fixed strings, so only cwd carries user input.)
 */
export function escapeFormat(value: string): string {
  return value.replace(/#/g, '##')
}

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

export class TmuxService implements TmuxApi {
  constructor(
    private readonly socket: string,
    private readonly configFile: string,
  ) {}

  async ensureConfig(): Promise<void> {
    await mkdir(dirname(this.configFile), { recursive: true })
    await writeFile(this.configFile, TMUX_CONF, 'utf8')
  }

  private baseArgs(): string[] {
    return ['-L', this.socket, '-f', this.configFile]
  }

  private tmux(args: string[]): Promise<string> {
    return run('tmux', [...this.baseArgs(), ...args])
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

  async newSession(name: string, cwd: string, windowName: string, command: string): Promise<void> {
    await this.tmux(['new-session', '-d', '-s', name, '-c', escapeFormat(cwd), '-n', windowName, command])
  }

  async killSession(name: string): Promise<void> {
    if (await this.hasSession(name)) await this.tmux(['kill-session', '-t', `=${name}`])
  }

  async listWindows(session: string): Promise<TabInfo[]> {
    const out = await this.tmux([
      'list-windows',
      '-t',
      `=${session}`,
      '-F',
      '#{window_index}\t#{window_name}\t#{window_active}',
    ])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [index, windowName, active] = line.split('\t')
        return { index: Number(index), name: windowName, active: active === '1' }
      })
  }

  async newWindow(session: string, cwd: string, windowName: string, command?: string): Promise<void> {
    await this.tmux([
      'new-window',
      '-t',
      `=${session}:`,
      '-c',
      escapeFormat(cwd),
      '-n',
      windowName,
      ...(command ? [command] : []),
    ])
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
