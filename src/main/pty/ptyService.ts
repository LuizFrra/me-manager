import type { IPty, IPtyForkOptions } from 'node-pty'
import type { PtyApi } from '../contracts'
import { isTermSize } from './termSize'

export type SpawnFn = (file: string, args: string[], options: IPtyForkOptions) => IPty

export class PtyService implements PtyApi {
  private proc: IPty | null = null
  private cols = 120
  private rows = 30
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(private readonly spawn: SpawnFn) {}

  attach(file: string, args: string[], cwd: string): void {
    this.detach()
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env.TERM = 'xterm-256color'
    delete env.TMUX // launched from inside tmux? attaching would be refused as "nested"
    const proc = this.spawn(file, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
    })
    this.proc = proc
    proc.onData((data) => {
      if (this.proc === proc) this.dataListeners.forEach((cb) => cb(data))
    })
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return
      this.proc = null
      this.exitListeners.forEach((cb) => cb(exitCode))
    })
  }

  detach(): void {
    const proc = this.proc
    this.proc = null
    proc?.kill()
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!isTermSize(cols) || !isTermSize(rows)) return
    this.cols = cols
    this.rows = rows
    this.proc?.resize(cols, rows)
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
}
