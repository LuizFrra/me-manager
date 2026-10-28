import { describe, expect, it, vi } from 'vitest'
import { PtyService, type SpawnFn } from './ptyService'

function fakeSpawn(): {
  spawn: SpawnFn & ReturnType<typeof vi.fn>
  procs: FakePty[]
} {
  const procs: FakePty[] = []
  const spawn = vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
    const p = new FakePty(file, args, opts)
    procs.push(p)
    return p
  }) as unknown as SpawnFn & ReturnType<typeof vi.fn>
  return { spawn, procs }
}

const noop = (): void => undefined

/** What PtyService spawns for a session, like TmuxService.attachCommand. */
const command = (session: string): { file: string; args: string[] } => ({ file: 'tmux', args: ['attach', session] })

class FakePty {
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  written: string[] = []
  size: [number, number] | null = null
  killed = false
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: Record<string, unknown>,
  ) {}
  onData(cb: (d: string) => void): { dispose(): void } {
    this.dataCb = cb
    return { dispose: noop }
  }
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void } {
    this.exitCb = cb
    return { dispose: noop }
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(c: number, r: number): void {
    this.size = [c, r]
  }
  kill(): void {
    this.killed = true
  }
}

describe('PtyService', () => {
  it("spawns the session's command with the remembered size and a clean env", () => {
    const { spawn, procs } = fakeSpawn()
    process.env.TMUX = '/tmp/tmux-1/default,1,0'
    const svc = new PtyService(spawn, command)
    svc.resize(100, 40)
    svc.attach('mmt_a', '/work')
    const opts = procs[0].opts as {
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
    }
    expect(procs[0].file).toBe('tmux')
    expect(procs[0].args).toEqual(['attach', 'mmt_a'])
    expect([opts.cols, opts.rows, opts.cwd]).toEqual([100, 40, '/work'])
    expect(opts.env.TERM).toBe('xterm-256color')
    expect(opts.env.TMUX).toBeUndefined()
    delete process.env.TMUX
  })

  it('forwards data, writes and resizes for the current pty', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn, command)
    const data: string[] = []
    svc.onData((d) => data.push(d))
    svc.attach('mmt_a', '/w')
    procs[0].dataCb('hello')
    svc.write('ls\r')
    svc.resize(90, 30)
    expect(data).toEqual(['hello'])
    expect(procs[0].written).toEqual(['ls\r'])
    expect(procs[0].size).toEqual([90, 30])
  })

  it('ignores a size that is not a whole number of at least 2, or more than tmux takes', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn, command)
    svc.attach('mmt_a', '/w')
    svc.resize(90, 30)
    for (const [c, r] of [
      [1, 30],
      [90.5, 30],
      [90, NaN],
      [Infinity, 30],
      [90, 10_001],
      ['90', '30'],
    ] as [number, number][]) {
      svc.resize(c, r)
    }
    expect(procs[0].size).toEqual([90, 30])
    svc.attach('mmt_a', '/w') // the next pty starts at the last good size
    expect([procs[1].opts.cols, procs[1].opts.rows]).toEqual([90, 30])
  })

  it('kills the previous pty on re-attach and ignores its late events', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn, command)
    const data: string[] = []
    const exits: number[] = []
    svc.onData((d) => data.push(d))
    svc.onExit((c) => exits.push(c))
    svc.attach('mmt_a', '/w')
    svc.attach('mmt_b', '/w')
    expect(procs[0].killed).toBe(true)
    procs[0].dataCb('stale')
    procs[0].exitCb({ exitCode: 0 })
    expect(data).toEqual([])
    expect(exits).toEqual([])
  })

  it('emits exit when the current pty ends', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn, command)
    const exits: number[] = []
    svc.onExit((c) => exits.push(c))
    svc.attach('mmt_a', '/w')
    procs[0].exitCb({ exitCode: 1 })
    expect(exits).toEqual([1])
    svc.write('ignored')
    expect(procs[0].written).toEqual([])
  })

  it('detach kills without emitting exit; unsubscribe works', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn, command)
    const exits: number[] = []
    const off = svc.onExit((c) => exits.push(c))
    svc.attach('mmt_a', '/w')
    svc.detach()
    expect(procs[0].killed).toBe(true)
    off()
    svc.attach('mmt_a', '/w')
    procs[1].exitCb({ exitCode: 0 })
    expect(exits).toEqual([])
  })
})
