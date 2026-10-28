import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { run } from '../exec'
import { ControlParser, decodeOutput, type ControlEvent } from './controlProtocol'

const b = (s: string): Buffer => Buffer.from(s, 'utf8')

/** A parser that records its events and warnings. */
function parser(): { p: ControlParser; events: ControlEvent[]; warn: ReturnType<typeof vi.fn> } {
  const events: ControlEvent[] = []
  const warn = vi.fn()
  return { p: new ControlParser((e) => events.push(e), warn), events, warn }
}

/** All bytes the given pane printed, in order. */
const outputOf = (events: ControlEvent[], pane: string): Buffer =>
  Buffer.concat(events.flatMap((e) => (e.kind === 'output' && e.pane === pane ? [e.data] : [])))

describe('decodeOutput', () => {
  it('turns \\ooo escapes into bytes and leaves everything else as is', () => {
    expect(decodeOutput(b('a\\134b'))).toEqual(b('a\\b'))
    expect(decodeOutput(b('\\033[1mx'))).toEqual(b('\x1b[1mx'))
    expect(decodeOutput(b('tick 2\\015\\012'))).toEqual(b('tick 2\r\n'))
    expect(decodeOutput(b('plain é 😀'))).toEqual(b('plain é 😀'))
    expect(decodeOutput(b(''))).toEqual(b(''))
  })

  it('keeps a backslash that is not followed by three octal digits', () => {
    expect(decodeOutput(b('a\\9z'))).toEqual(b('a\\9z'))
    expect(decodeOutput(b('end\\01'))).toEqual(b('end\\01'))
    expect(decodeOutput(b('\\'))).toEqual(b('\\'))
  })
})

describe('ControlParser', () => {
  it('emits output with the pane and the decoded bytes', () => {
    const { p, events } = parser()
    p.feed(b('%output %0 tick 2\\015\\012\n'))
    expect(events).toEqual([{ kind: 'output', pane: '%0', data: b('tick 2\r\n') }])
  })

  it('keeps an empty payload and spaces inside it', () => {
    const { p, events } = parser()
    p.feed(b('%output %1 \n%output %1  a b \n'))
    expect(events).toEqual([
      { kind: 'output', pane: '%1', data: b('') },
      { kind: 'output', pane: '%1', data: b(' a b ') },
    ])
  })

  it('keeps a UTF-8 character split across two chunks intact', () => {
    const { p, events } = parser()
    const line = b('%output %2 x😀é y\n')
    const cut = line.indexOf(0xf0) + 2 // in the middle of the emoji
    p.feed(line.subarray(0, cut))
    expect(events).toEqual([])
    p.feed(line.subarray(cut))
    expect(outputOf(events, '%2').toString('utf8')).toBe('x😀é y')
  })

  it('joins a line split across many chunks, and several lines in one chunk', () => {
    const { p, events } = parser()
    const all = b('%output %0 ab\\015\\012\n%window-pane-changed @1 %4\n%output %4 cd\n')
    for (let i = 0; i < all.length; i++) p.feed(all.subarray(i, i + 1))
    expect(events).toEqual([
      { kind: 'output', pane: '%0', data: b('ab\r\n') },
      { kind: 'pane-changed', window: '@1', pane: '%4' },
      { kind: 'output', pane: '%4', data: b('cd') },
    ])
  })

  it('treats every line of a block as reply text, even one that looks like a notification', () => {
    const { p, events } = parser()
    p.feed(b('%begin 1793142855 293 1\n100x30 %1 0,1 alt=0\n%output %0 not output\n%end 1793142855 293 1\n'))
    expect(events).toEqual([
      { kind: 'reply', ok: true, lines: ['100x30 %1 0,1 alt=0', '%output %0 not output'], ours: true },
    ])
  })

  it('ends a block only at the %end with its own number', () => {
    const { p, events } = parser()
    p.feed(b('%begin 1 7 1\n%end 1 8 1\nlast\n%end 1 7 1\n'))
    expect(events).toEqual([{ kind: 'reply', ok: true, lines: ['%end 1 8 1', 'last'], ours: true }])
  })

  it('ends a block only at a guard with its time and flags too, so captured text cannot fake the end', () => {
    // A pane can print a line that looks like a guard, and a capture of it is reply text; its time won't match.
    const { p, events } = parser()
    p.feed(b('%begin 1793 7 1\n%end 1792 7 1\n%error 1793 7 0\n%end 1793 7 1 x\nlast\n%end 1793 7 1\n'))
    expect(events).toEqual([
      { kind: 'reply', ok: true, lines: ['%end 1792 7 1', '%error 1793 7 0', '%end 1793 7 1 x', 'last'], ours: true },
    ])
  })

  it('decodes reply lines as UTF-8, across chunks', () => {
    const { p, events } = parser()
    const all = b('%begin 1 2 1\nolá 😀\n%end 1 2 1\n')
    const cut = all.indexOf(0xf0) + 1
    p.feed(all.subarray(0, cut))
    p.feed(all.subarray(cut))
    expect(events).toEqual([{ kind: 'reply', ok: true, lines: ['olá 😀'], ours: true }])
  })

  it('reports %error as a failed reply', () => {
    const { p, events } = parser()
    p.feed(b('%begin 1 3 1\nunknown command: nope\n%error 1 3 1\n'))
    expect(events).toEqual([{ kind: 'reply', ok: false, lines: ['unknown command: nope'], ours: true }])
  })

  it("tells this client's commands (flags 1) from the attach's own block (flags 0)", () => {
    const { p, events } = parser()
    p.feed(b('%begin 1793142853 279 0\n%end 1793142853 279 0\n%begin 1793142853 284 1\n%end 1793142853 284 1\n'))
    expect(events).toEqual([
      { kind: 'reply', ok: true, lines: [], ours: false },
      { kind: 'reply', ok: true, lines: [], ours: true },
    ])
  })

  it('emits window and pane changes', () => {
    const { p, events } = parser()
    p.feed(b('%session-window-changed $0 @1\n%window-pane-changed @1 %3\n'))
    expect(events).toEqual([
      { kind: 'window-changed', session: '$0', window: '@1' },
      { kind: 'pane-changed', window: '@1', pane: '%3' },
    ])
  })

  it('emits %exit with and without a reason', () => {
    const { p, events } = parser()
    p.feed(b('%exit\n%exit server exited\n'))
    expect(events).toEqual([
      { kind: 'exit', reason: '' },
      { kind: 'exit', reason: 'server exited' },
    ])
  })

  it('ignores notifications it does not know, silently', () => {
    const { p, events, warn } = parser()
    p.feed(
      b(
        '%session-changed $0 s\n%layout-change @0 a87d,100x30,0,0,0 a87d,100x30,0,0,0 *\n' +
          '%window-renamed @0 cat\n%sessions-changed\n%extended-output %0 12 : x\n',
      ),
    )
    expect(events).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns about garbage and malformed lines, without throwing, and keeps parsing', () => {
    const { p, events, warn } = parser()
    expect(() =>
      p.feed(
        b(
          'garbage here\n%output\n%output nopane\n%begin x\n%session-window-changed $0\n' +
            '%session-window-changed 0 @1\n%window-pane-changed @1\n\n%output %0 ok\n',
        ),
      ),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(8) // the empty line too
    expect(events).toEqual([{ kind: 'output', pane: '%0', data: b('ok') }])
  })

  it('strips a trailing \\r so a CRLF stream parses too', () => {
    const { p, events } = parser()
    p.feed(b('%begin 1 2 1\r\nhi\r\n%end 1 2 1\r\n%exit\r\n'))
    expect(events).toEqual([
      { kind: 'reply', ok: true, lines: ['hi'], ours: true },
      { kind: 'exit', reason: '' },
    ])
  })

  it('does not need a warn callback', () => {
    const p = new ControlParser(() => {})
    expect(() => p.feed(b('garbage\n'))).not.toThrow()
  })
})

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const socket = `mm-test-cp-${process.pid}-${Date.now()}`

/** Polls `check` until it is true, failing after `ms`. */
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.skipIf(!hasTmux)('ControlParser with a real tmux', () => {
  afterAll(async () => {
    await run('tmux', ['-L', socket, 'kill-server']).catch(() => {})
    // tmux leaves the socket file behind when the server exits; remove it too.
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
  })

  it('parses a control client: a block per command, and raw UTF-8 output', async () => {
    const session = 'mmcp'
    await run('tmux', [
      '-L',
      socket,
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      '100',
      '-y',
      '30',
      'exec cat',
    ])
    const env = { ...process.env }
    delete env.TMUX
    const proc = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', `=${session}`], { stdio: 'pipe', env })
    try {
      const events: ControlEvent[] = []
      const warn = vi.fn()
      const p = new ControlParser((e) => events.push(e), warn)
      proc.stdout.on('data', (chunk: Buffer) => p.feed(chunk))
      const ours = (): Extract<ControlEvent, { kind: 'reply' }>[] =>
        events.filter((e): e is Extract<ControlEvent, { kind: 'reply' }> => e.kind === 'reply' && e.ours)

      // The attach's own block comes first; wait for it so the next reply is the one we ask for.
      await until(() => events.some((e) => e.kind === 'reply' && !e.ours), 'the attach block')
      // Control mode reads tmux's own command language: a bare ';' separates commands, and each one gets its
      // own block. A line that doesn't parse (here `\;` is an extra argument) is one failed block.
      proc.stdin.write('display -p hello ; display -p world\n')
      proc.stdin.write('display -p hello \\; display -p world\n')
      await until(() => ours().length >= 3, 'the replies')
      expect(ours()).toEqual([
        { kind: 'reply', ok: true, lines: ['hello'], ours: true },
        { kind: 'reply', ok: true, lines: ['world'], ours: true },
        { kind: 'reply', ok: false, lines: [expect.stringContaining('too many arguments')], ours: true },
      ])

      const pane = (await run('tmux', ['-L', socket, 'display', '-p', '-t', `=${session}:`, '#{pane_id}'])).trim()
      proc.stdin.write(`send-keys -t =${session}: -H 68 c3 a9 0d\n`)
      await until(() => outputOf(events, pane).includes(b('hé')), 'the echoed output')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      proc.kill()
    }
  })
})
