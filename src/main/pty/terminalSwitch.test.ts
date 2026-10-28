import { describe, expect, it } from 'vitest'
import type { TerminalMode } from '../../shared/types'
import type { PtyApi } from '../contracts'
import { TerminalSwitch } from './terminalSwitch'

/** A terminal that records what it was asked to do, and emits data and exits on demand. */
class FakeTerminal implements PtyApi {
  attached: { session: string; cwd: string } | null = null
  detached = 0
  written: string[] = []
  size: [number, number] | null = null
  private readonly dataCbs = new Set<(data: string) => void>()
  private readonly exitCbs = new Set<(code: number) => void>()
  attach(session: string, cwd: string): void {
    this.attached = { session, cwd }
  }
  detach(): void {
    this.attached = null
    this.detached++
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.size = [cols, rows]
  }
  onData(cb: (data: string) => void): () => void {
    this.dataCbs.add(cb)
    return () => this.dataCbs.delete(cb)
  }
  onExit(cb: (code: number) => void): () => void {
    this.exitCbs.add(cb)
    return () => this.exitCbs.delete(cb)
  }
  emitData(data: string): void {
    this.dataCbs.forEach((cb) => cb(data))
  }
  emitExit(code: number): void {
    this.exitCbs.forEach((cb) => cb(code))
  }
}

function setup(initial: TerminalMode = 'direct'): {
  sw: TerminalSwitch
  direct: FakeTerminal
  classic: FakeTerminal
  setMode: (m: TerminalMode) => void
  data: string[]
  exits: number[]
} {
  let mode = initial
  const direct = new FakeTerminal()
  const classic = new FakeTerminal()
  const sw = new TerminalSwitch({ direct, classic }, () => mode)
  const data: string[] = []
  const exits: number[] = []
  sw.onData((d) => data.push(d))
  sw.onExit((c) => exits.push(c))
  return { sw, direct, classic, setMode: (m) => (mode = m), data, exits }
}

describe('TerminalSwitch', () => {
  it("attaches the mode's terminal and detaches the other", () => {
    const { sw, direct, classic } = setup('direct')
    sw.attach('mmt_a', '/w')
    expect(direct.attached).toEqual({ session: 'mmt_a', cwd: '/w' })
    expect(classic.attached).toBeNull()
    expect(classic.detached).toBe(1)
  })

  it('moves over to the other terminal when the mode changed before the next attach', () => {
    const { sw, direct, classic, setMode } = setup('direct')
    sw.attach('mmt_a', '/w')
    setMode('classic')
    sw.attach('mmt_a', '/w')
    expect(direct.attached).toBeNull()
    expect(classic.attached).toEqual({ session: 'mmt_a', cwd: '/w' })
  })

  it('forwards data and exits from the active terminal only', () => {
    const { sw, direct, classic, setMode, data, exits } = setup('direct')
    sw.attach('mmt_a', '/w')
    direct.emitData('from direct')
    classic.emitData('stale')
    classic.emitExit(1)
    setMode('classic')
    sw.attach('mmt_a', '/w')
    direct.emitData('late')
    direct.emitExit(0)
    classic.emitData('from classic')
    classic.emitExit(2)
    expect(data).toEqual(['from direct', 'from classic'])
    expect(exits).toEqual([2])
  })

  it('writes to the active terminal only', () => {
    const { sw, direct, classic } = setup('classic')
    sw.write('nothing shown')
    sw.attach('mmt_a', '/w')
    sw.write('ls\r')
    expect(classic.written).toEqual(['ls\r'])
    expect(direct.written).toEqual([])
  })

  it('resizes both, so either starts at the right size', () => {
    const { sw, direct, classic } = setup('direct')
    sw.resize(100, 40)
    expect(direct.size).toEqual([100, 40])
    expect(classic.size).toEqual([100, 40])
  })

  it('detach stops the active terminal and forgets it', () => {
    const { sw, direct, data, exits } = setup('direct')
    sw.attach('mmt_a', '/w')
    sw.detach()
    expect(direct.attached).toBeNull()
    sw.write('ignored')
    direct.emitData('late')
    direct.emitExit(0)
    expect(direct.written).toEqual([])
    expect(data).toEqual([])
    expect(exits).toEqual([])
  })

  it('unsubscribes a listener', () => {
    const { sw, direct } = setup('direct')
    const seen: string[] = []
    const off = sw.onData((d) => seen.push(d))
    sw.attach('mmt_a', '/w')
    off()
    direct.emitData('x')
    expect(seen).toEqual([])
  })
})
