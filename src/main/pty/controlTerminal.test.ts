import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { inputCommands } from './controlInput'
import { ControlTerminal, type ControlProcess } from './controlTerminal'
import { leaveModeCommand, parseSnapshot, snapshotCommand, snapshotData, type Snapshot } from './snapshot'

const ESC = '\x1b'

/** Lets the streams deliver what was written to them. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** A state line for `pane` in `window` of session $1: 40x10 on the normal screen, nothing special set. */
const stateLine = (pane: string, window = '@1'): string =>
  `${pane} $1 ${window} 0 4294967295 4294967295 1 0 0 0 0 0 0 0 0 0 0 0 0 9 1 10`

/** What the terminal shows for a snapshot of `pane` with these lines. */
const shown = (pane: string, lines: string[]): string =>
  snapshotData(parseSnapshot([lines, [], [stateLine(pane)]]) as Snapshot)

/** A control client as tmux runs it: records the lines written to it and answers with protocol text. */
class FakeControl implements ControlProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly lines: string[] = []
  killed = false
  private readonly exitCbs: (() => void)[] = []
  private num = 0
  private partial = ''

  constructor(
    readonly session: string,
    readonly cwd: string,
  ) {
    this.stdin.on('data', (d: Buffer) => {
      const parts = (this.partial + d.toString()).split('\n')
      this.partial = parts.pop() ?? ''
      this.lines.push(...parts)
    })
  }

  kill(): void {
    this.killed = true
  }

  on(_event: 'exit', cb: () => void): void {
    this.exitCbs.push(cb)
  }

  /** The process exits. */
  exit(): void {
    for (const cb of this.exitCbs) cb()
  }

  /** Writes protocol text to stdout as one chunk, and lets it be read. */
  async push(...texts: string[]): Promise<void> {
    this.stdout.write(texts.join(''))
    await tick()
  }

  /** A reply block: to one of our commands, or (ours false) to the attach. */
  reply(lines: string[] = [], ok = true, ours = true): string {
    const n = ++this.num
    const flags = ours ? 1 : 0
    const body = lines.map((l) => `${l}\n`).join('')
    return `%begin 1 ${n} ${flags}\n${body}%${ok ? 'end' : 'error'} 1 ${n} ${flags}\n`
  }

  /** The replies to leaving the pane's mode and to a snapshot of `pane` (in `window` of session $1) showing `lines`. */
  snapshot(pane: string, lines: string[], window = '@1'): string {
    return this.reply() + this.reply(lines) + this.reply() + this.reply([stateLine(pane, window)])
  }

  /** The attach's own block and the reply to the first refresh-client. */
  attached(): string {
    return this.reply([], true, false) + this.reply()
  }
}

const output = (pane: string, text: string): string => `%output ${pane} ${text}\n`

function setup(): {
  term: ControlTerminal
  procs: FakeControl[]
  data: string[]
  exits: number[]
  warnings: string[]
  proc: () => FakeControl
} {
  const procs: FakeControl[] = []
  const warnings: string[] = []
  const term = new ControlTerminal(
    (session, cwd) => {
      const p = new FakeControl(session, cwd)
      procs.push(p)
      return p
    },
    (msg) => warnings.push(msg),
  )
  const data: string[] = []
  const exits: number[] = []
  term.onData((d) => data.push(d))
  term.onExit((c) => exits.push(c))
  const proc = (): FakeControl => {
    const p = procs.at(-1)
    if (!p) throw new Error('nothing spawned')
    return p
  }
  return { term, procs, data, exits, warnings, proc }
}

/** Attached to `mm_s` and showing pane %3 with the line 'hi'. */
async function shownPane(): Promise<ReturnType<typeof setup>> {
  const s = setup()
  s.term.attach('mm_s', '/work')
  await tick()
  await s.proc().push(s.proc().attached(), s.proc().snapshot('%3', ['hi']))
  s.data.length = 0
  return s
}

describe('ControlTerminal: attach and snapshot', () => {
  it('spawns for the session, sizes the client and asks for a snapshot of its active pane', async () => {
    const { term, proc } = setup()
    term.attach('mm_s', '/work')
    await tick()
    expect([proc().session, proc().cwd]).toEqual(['mm_s', '/work'])
    expect(proc().lines).toEqual(['refresh-client -C 120x30', leaveModeCommand('=mm_s:'), snapshotCommand('=mm_s:')])
  })

  it('takes the pane out of any mode before each snapshot, on a line of its own', async () => {
    // In copy mode, keys go to tmux's copy-mode key table instead of the program.
    const { proc } = await shownPane()
    const before = proc().lines.length
    await proc().push('%session-window-changed $1 @2\n')
    expect(proc().lines.slice(before)).toEqual([leaveModeCommand('=mm_s:'), snapshotCommand('=mm_s:')])
  })

  it('still shows the snapshot when leaving the mode failed, and warns', async () => {
    const { term, proc, data, warnings } = setup()
    term.attach('mm_s', '/work')
    await tick()
    await proc().push(proc().attached(), proc().reply(['unknown flag -q'], false))
    await proc().push(proc().reply(['a']), proc().reply(), proc().reply([stateLine('%3')]))
    expect(data).toEqual([shown('%3', ['a'])])
    expect(warnings).toEqual([expect.stringContaining('unknown flag -q')])
  })

  it('shows the snapshot once its three replies are in', async () => {
    const { term, proc, data } = setup()
    term.attach('mm_s', '/work')
    await tick()
    await proc().push(proc().attached(), proc().reply(), proc().reply(['a', 'b']), proc().reply())
    expect(data).toEqual([])
    await proc().push(proc().reply([stateLine('%3')]))
    expect(data).toEqual([shown('%3', ['a', 'b'])])
  })

  it('drops output until the snapshot is in, then shows the active pane’s output', async () => {
    const { term, proc, data } = setup()
    term.attach('mm_s', '/work')
    await tick()
    await proc().push(proc().attached(), output('%3', 'before'))
    expect(data).toEqual([])
    await proc().push(proc().snapshot('%3', ['hi']), output('%3', 'after'))
    expect(data).toEqual([shown('%3', ['hi']) + 'after'])
  })

  it('ignores output of other panes', async () => {
    const { proc, data } = await shownPane()
    await proc().push(output('%4', 'other'), output('%3', 'mine'))
    expect(data).toEqual(['mine'])
  })

  it('keeps a character split across two outputs whole', async () => {
    const { proc, data } = await shownPane()
    // é is c3 a9: tmux sends bytes >= 0x80 raw, and may cut a character between two %output lines.
    proc().stdout.write(Buffer.concat([Buffer.from('%output %3 x'), Buffer.from([0xc3]), Buffer.from('\n')]))
    await tick()
    proc().stdout.write(Buffer.concat([Buffer.from('%output %3 '), Buffer.from([0xa9]), Buffer.from('y\n')]))
    await tick()
    expect(data.join('')).toBe('xéy')
  })

  it('does not carry half a character of the old pane over to the new one', async () => {
    const { proc, data } = await shownPane()
    proc().stdout.write(Buffer.concat([Buffer.from('%output %3 '), Buffer.from([0xc3]), Buffer.from('\n')]))
    await tick()
    await proc().push('%session-window-changed $1 @2\n', proc().snapshot('%5', ['w2']), output('%5', 'x'))
    expect(data).toEqual([shown('%5', ['w2']) + 'x'])
  })

  it('turns escapes back into bytes', async () => {
    const { proc, data } = await shownPane()
    await proc().push(output('%3', 'a\\015\\012b\\134'))
    expect(data).toEqual(['a\r\nb\\'])
  })

  it('emits once per chunk, however many outputs it holds', async () => {
    const { proc, data } = await shownPane()
    await proc().push(output('%3', 'a'), output('%3', 'b'), output('%4', 'x'), output('%3', 'c'))
    expect(data).toEqual(['abc'])
  })

  it('takes a new snapshot when the window or the pane changes, and follows the new pane', async () => {
    const { proc, data } = await shownPane()
    await proc().push('%session-window-changed $1 @2\n')
    expect(proc().lines.at(-1)).toBe(snapshotCommand('=mm_s:'))
    await proc().push(
      output('%3', 'old'),
      proc().snapshot('%5', ['w2'], '@2'),
      output('%3', 'old'),
      output('%5', 'new'),
    )
    expect(data).toEqual([shown('%5', ['w2']) + 'new'])
    data.length = 0
    await proc().push('%window-pane-changed @2 %6\n')
    expect(proc().lines.filter((l) => l === snapshotCommand('=mm_s:'))).toHaveLength(3)
    await proc().push(proc().snapshot('%6', ['split'], '@2'))
    expect(data).toEqual([shown('%6', ['split'])])
  })

  it('ignores window and pane changes of other sessions and windows', async () => {
    // tmux tells every control client about every session's window changes and every window's pane changes.
    const { proc, data } = await shownPane()
    const before = proc().lines.length
    await proc().push('%session-window-changed $2 @7\n', '%window-pane-changed @7 %8\n', output('%3', 'x'))
    expect(proc().lines).toHaveLength(before)
    expect(data).toEqual(['x'])
  })

  it('follows its own session to a new window, and that window’s pane changes', async () => {
    const { proc } = await shownPane()
    const before = proc().lines.length
    // The window is known before the new snapshot is in: its pane changes count already.
    await proc().push('%session-window-changed $1 @2\n', '%window-pane-changed @2 %6\n', '%window-pane-changed @1 %4\n')
    expect(
      proc()
        .lines.slice(before)
        .filter((l) => l === snapshotCommand('=mm_s:')),
    ).toHaveLength(2)
    expect(proc().lines).toHaveLength(before + 4)
  })

  it('takes a new snapshot on any window change while no snapshot was shown yet', async () => {
    const { term, proc } = setup()
    term.attach('mm_s', '/work')
    await tick()
    await proc().push(proc().attached(), '%session-window-changed $9 @9\n')
    expect(proc().lines.filter((l) => l === snapshotCommand('=mm_s:'))).toHaveLength(2)
  })

  it('discards a snapshot that a newer one replaced, and shows only the newer one', async () => {
    const { proc, data } = await shownPane()
    await proc().push('%session-window-changed $1 @2\n', '%session-window-changed $1 @3\n')
    await proc().push(proc().snapshot('%5', ['stale']), output('%5', 'x'), output('%6', 'y'))
    expect(data).toEqual([])
    await proc().push(proc().snapshot('%6', ['fresh']), output('%6', 'z'))
    expect(data).toEqual([shown('%6', ['fresh']) + 'z'])
  })

  it('shows a notice when the snapshot fails, keeps the previous pane and the replies in step', async () => {
    const { term, proc, data, warnings } = await shownPane()
    await proc().push('%session-window-changed $1 @2\n')
    // tmux answers a group of commands that failed with one %error, and skips the rest of the group.
    await proc().push(proc().reply(), proc().reply(["can't find window: @2", 'more'], false))
    expect(data).toEqual([`${ESC}c${ESC}[2m[could not show this tab: can't find window: @2]${ESC}[0m\r\n`])
    data.length = 0
    await proc().push(output('%3', 'still'))
    expect(data).toEqual(['still'])
    data.length = 0
    // The next replies are the keystrokes', not taken for the snapshot's.
    term.write('ab')
    await tick()
    await proc().push(proc().reply(), output('%3', 'ab'), proc().reply())
    expect(data).toEqual(['ab'])
    expect(warnings).toEqual([expect.stringContaining('a reply to nothing')])
  })

  it('lets a newer snapshot finish when an older one fails', async () => {
    const { proc, data } = await shownPane()
    await proc().push('%session-window-changed $1 @2\n', '%session-window-changed $1 @3\n')
    await proc().push(proc().reply(), proc().reply(["can't find window: @2"], false), output('%3', 'x'))
    expect(data).toEqual([])
    await proc().push(proc().snapshot('%6', ['fresh']), output('%6', 'z'))
    expect(data).toEqual([shown('%6', ['fresh']) + 'z'])
  })

  it('shows a notice when the state line is malformed, with no pane to show before', async () => {
    const { term, proc, data } = setup()
    term.attach('mm_s', '/work')
    await tick()
    await proc().push(proc().attached(), proc().reply(), proc().reply(['a']), proc().reply(), proc().reply(['garbage']))
    expect(data).toEqual([`${ESC}c${ESC}[2m[could not show this tab: tmux sent a malformed pane state]${ESC}[0m\r\n`])
    data.length = 0
    await proc().push(output('%3', 'x'))
    expect(data).toEqual([])
  })

  it('ignores replies it did not ask for, and warns about extra ones', async () => {
    const { proc, data, warnings } = await shownPane()
    await proc().push(proc().reply(['x'], true, false), output('%3', 'a'))
    expect(data).toEqual(['a'])
    expect(warnings).toEqual([])
    await proc().push(proc().reply(['x']))
    expect(warnings).toHaveLength(1)
  })
})

describe('ControlTerminal: input and size', () => {
  it('sends typed text to the shown pane, a command per line', async () => {
    const { term, proc } = await shownPane()
    const before = proc().lines.length
    term.write('hi\r')
    await tick()
    expect(proc().lines.slice(before)).toEqual(inputCommands('%3', 'hi\r'))
  })

  it('sends a bracketed paste through a paste buffer', async () => {
    const { term, proc } = await shownPane()
    const before = proc().lines.length
    term.write(`${ESC}[200~a\rb${ESC}[201~`)
    await tick()
    expect(proc().lines.slice(before)).toEqual([
      'set-buffer -b mm-paste-3 "a\\012b"',
      'paste-buffer -p -d -b mm-paste-3 -t %3',
    ])
  })

  it('expects a reply per command it sent, and warns about failed ones', async () => {
    const { term, proc, data, warnings } = await shownPane()
    term.write(`${ESC}[200~a${ESC}[201~`)
    await tick()
    await proc().push(proc().reply(), proc().reply(['no buffer'], false))
    expect(warnings).toEqual([expect.stringContaining('no buffer')])
    // The FIFO is in step: the next snapshot's replies are taken as such.
    await proc().push('%session-window-changed $1 @2\n', proc().snapshot('%5', ['w2']))
    expect(data).toEqual([shown('%5', ['w2'])])
  })

  it('sends nothing before the first snapshot is in', async () => {
    const { term, proc } = setup()
    term.write('lost')
    term.attach('mm_s', '/work')
    await tick()
    term.write('lost too')
    await tick()
    expect(proc().lines).toHaveLength(3)
  })

  it('sizes the client, ignores sizes no terminal has, and remembers the size for the next attach', async () => {
    const { term, proc } = await shownPane()
    const before = proc().lines.length
    term.resize(100, 40)
    for (const [c, r] of [
      [0, 40],
      [100, 1],
      [1.5, 40],
      [100, 10_001],
      [NaN, 40],
    ] as const)
      term.resize(c, r)
    await tick()
    expect(proc().lines.slice(before)).toEqual(['refresh-client -C 100x40'])
    term.attach('mm_t', '/work')
    await tick()
    expect(proc().lines[0]).toBe('refresh-client -C 100x40')
  })

  it('remembers a size set before any attach', async () => {
    const { term, proc } = setup()
    term.resize(90, 20)
    term.attach('mm_s', '/work')
    await tick()
    expect(proc().lines[0]).toBe('refresh-client -C 90x20')
  })

  it('does not throw when stdin is gone', async () => {
    const { term, proc } = await shownPane()
    proc().stdin.destroy()
    await tick()
    expect(() => {
      term.write('x')
      term.resize(50, 20)
    }).not.toThrow()
    proc().stdin.emit('error', new Error('EPIPE'))
    await tick()
  })

  it('does not throw when stdin fails a write', async () => {
    const { term, proc } = await shownPane()
    proc().stdin.write = (): boolean => {
      throw new Error('write EPIPE')
    }
    expect(() => term.write('x')).not.toThrow()
  })
})

describe('ControlTerminal: exit and detach', () => {
  it('emits exit once on %exit, before the process exits', async () => {
    const { proc, exits, data } = await shownPane()
    await proc().push(output('%3', 'bye'), '%exit\n')
    expect(data).toEqual(['bye'])
    expect(exits).toEqual([0])
    proc().exit()
    await proc().push(output('%3', 'late'))
    expect(exits).toEqual([0])
    expect(data).toEqual(['bye'])
  })

  it('emits exit once when the process exits', async () => {
    const { proc, exits } = await shownPane()
    proc().exit()
    proc().exit()
    expect(exits).toEqual([0])
  })

  it('does not emit exit after detach, and kills the process', async () => {
    const { term, proc, exits, data } = await shownPane()
    term.detach()
    expect(proc().killed).toBe(true)
    await proc().push(output('%3', 'late'), '%exit\n')
    proc().exit()
    expect(exits).toEqual([])
    expect(data).toEqual([])
  })

  it('kills the old process on re-attach and ignores what it says afterwards', async () => {
    const { term, procs, exits, data } = await shownPane()
    term.attach('mm_t', '/other')
    await tick()
    const [old, cur] = procs as [FakeControl, FakeControl]
    expect(old.killed).toBe(true)
    expect(cur.killed).toBe(false)
    await old.push(output('%3', 'late'), old.snapshot('%3', ['x']), '%exit\n')
    old.exit()
    expect(exits).toEqual([])
    expect(data).toEqual([])
    await cur.push(cur.attached(), cur.snapshot('%9', ['new']))
    expect(data).toEqual([shown('%9', ['new'])])
  })

  it('drops input after exit', async () => {
    const { term, proc } = await shownPane()
    proc().exit()
    const before = proc().lines.length
    term.write('x')
    await tick()
    expect(proc().lines).toHaveLength(before)
  })
})

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const socket = `mm-test-ctl-${process.pid}-${Date.now()}`

/** Polls `check` until it is true, failing after `ms`. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const tmux = (...args: string[]): Promise<string> => run('tmux', ['-L', socket, ...args])

describe.skipIf(!hasTmux)('ControlTerminal on a real tmux session', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-ctl-'))
  })

  afterAll(async () => {
    await tmux('kill-server').catch(() => {})
    // tmux leaves the socket file behind when the server exits; remove it too.
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('shows the pane, types into it, follows a new window and exits with the session', async () => {
    await tmux(
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      'mmctl',
      '-x',
      '80',
      '-y',
      '24',
      "printf 'start\\n'; exec cat",
    )
    await until(async () => (await tmux('capture-pane', '-p', '-t', '=mmctl:')).includes('start'), 'start')

    const env = { ...process.env }
    delete env.TMUX
    const children: ReturnType<typeof spawn>[] = []
    const warnings: string[] = []
    const term = new ControlTerminal(
      (session, cwd) => {
        const child = spawn('tmux', ['-L', socket, '-f', '/dev/null', '-C', 'attach-session', '-t', `=${session}`], {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'ignore'],
        })
        children.push(child)
        return child
      },
      (msg) => warnings.push(msg),
    )
    let data = ''
    const exits: number[] = []
    term.onData((d) => (data += d))
    term.onExit((c) => exits.push(c))
    try {
      term.attach('mmctl', dir)
      await until(() => data.includes('start'), 'the snapshot')
      expect(data.startsWith(`${ESC}c`)).toBe(true)

      data = ''
      term.write('hello\r')
      await until(() => data.includes('hello'), 'the echo')

      data = ''
      await tmux('new-window', '-t', '=mmctl', '-n', 'w2', 'printf second\\\\n; exec cat')
      await until(() => data.includes(`${ESC}c`) && data.includes('second'), 'the second window')

      const child = children[0]
      const exited = new Promise<void>((r) => child?.on('exit', () => r()))
      await tmux('kill-session', '-t', '=mmctl')
      await until(() => exits.length > 0, 'the exit')
      await exited
      await tick()
      expect(exits).toEqual([0])
      expect(warnings).toEqual([])
    } finally {
      term.detach()
    }
  })
})
