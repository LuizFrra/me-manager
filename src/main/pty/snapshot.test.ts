// @vitest-environment jsdom
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Terminal } from '@xterm/xterm'
import { afterAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { ControlParser, type ControlEvent } from './controlProtocol'
import {
  HISTORY_LINES,
  parseSnapshot,
  SNAPSHOT_REPLIES,
  snapshotCommand,
  snapshotData,
  type PaneState,
  type Snapshot,
} from './snapshot'

const ESC = '\x1b'

/** A pane on the normal screen with nothing special set: 40x10, cursor visible, wrapping, whole-screen region. */
const plain: PaneState = {
  pane: '%3',
  alternate: false,
  altSavedX: 4294967295,
  altSavedY: 4294967295,
  cursorVisible: true,
  cursorX: 0,
  cursorY: 0,
  insert: false,
  keypadCursor: false,
  keypad: false,
  mouseStandard: false,
  mouseButton: false,
  mouseAll: false,
  mouseSgr: false,
  mouseUtf8: false,
  origin: false,
  scrollTop: 0,
  scrollBottom: 9,
  wrap: true,
  height: 10,
}

const snap = (state: Partial<PaneState>, normal = ['a'], alternate: string[] | null = null): Snapshot => ({
  state: { ...plain, ...state },
  normal,
  alternate,
})

/** What snapshotData writes after the screens, for a pane on the normal screen with lines ['a']. */
const after = (data: string): string => data.slice(`${ESC}ca${ESC}[0m`.length)

describe('snapshotCommand', () => {
  it('asks for the current grid with history, the saved grid and the state, as three commands', () => {
    const cmd = snapshotCommand('=mm_x:')
    const parts = cmd.split(' ; ')
    expect(parts).toHaveLength(SNAPSHOT_REPLIES)
    expect(parts[0]).toBe(`capture-pane -p -e -J -S -${HISTORY_LINES} -t =mm_x:`)
    expect(parts[1]).toBe('capture-pane -p -e -J -a -q -t =mm_x:')
    expect(parts[2]).toMatch(/^display-message -p -t =mm_x: '#\{pane_id\} #\{alternate_on\} [^']*#\{pane_height\}'$/)
    expect(cmd).not.toContain('\n')
  })

  it('takes a pane id as the target', () => {
    expect(snapshotCommand('%3')).toContain('-t %3 ;')
  })

  it('refuses a target that could break out of the command line', () => {
    for (const bad of ["a'b", 'a"b', 'a b', 'a;b', 'a\nb', '']) expect(() => snapshotCommand(bad)).toThrow()
  })
})

describe('parseSnapshot', () => {
  const stateLine = (alt: 0 | 1, extra = ''): string =>
    `%7 ${alt} ${alt ? '2 3' : '4294967295 4294967295'} 0 5 6 1 1 1 1 1 1 1 1 1 2 8 0 10${extra}`

  it('reads the normal screen and every state field', () => {
    const s = parseSnapshot([['1', '2', ''], [], [stateLine(0)]])
    expect(s).toEqual({
      normal: ['1', '2', ''],
      alternate: null,
      state: {
        pane: '%7',
        alternate: false,
        altSavedX: 4294967295,
        altSavedY: 4294967295,
        cursorVisible: false,
        cursorX: 5,
        cursorY: 6,
        insert: true,
        keypadCursor: true,
        keypad: true,
        mouseStandard: true,
        mouseButton: true,
        mouseAll: true,
        mouseSgr: true,
        mouseUtf8: true,
        origin: true,
        scrollTop: 2,
        scrollBottom: 8,
        wrap: false,
        height: 10,
      },
    })
  })

  it('on the alternate screen, takes the last screenful as the alternate screen and the rest as history', () => {
    // On the alternate screen tmux's current grid still holds the history, so the first capture is the history
    // followed by the alternate screen; the saved (normal) screen goes after that history.
    const alt = Array.from({ length: 10 }, (_, i) => `alt ${i}`)
    const saved = Array.from({ length: 10 }, (_, i) => `saved ${i}`)
    const s = parseSnapshot([['h1', 'h2', ...alt], saved, [stateLine(1)]])
    expect(s?.state.alternate).toBe(true)
    expect(s?.state.altSavedX).toBe(2)
    expect(s?.state.altSavedY).toBe(3)
    expect(s?.alternate).toEqual(alt)
    expect(s?.normal).toEqual(['h1', 'h2', ...saved])
  })

  it('returns null when the state line is missing or malformed', () => {
    expect(parseSnapshot([['a'], [], []])).toBeNull()
    expect(parseSnapshot([['a'], []])).toBeNull()
    expect(parseSnapshot([['a'], [], ['']])).toBeNull()
    expect(parseSnapshot([['a'], [], [stateLine(0, ' 1')]])).toBeNull()
    expect(parseSnapshot([['a'], [], [stateLine(0).replace('%7', '7')]])).toBeNull()
    expect(parseSnapshot([['a'], [], [stateLine(0).replace(' 0 5 ', ' x 5 ')]])).toBeNull()
    expect(parseSnapshot([['a'], [], [stateLine(0).replace(' 0 5 ', ' 2 5 ')]])).toBeNull()
  })
})

describe('snapshotData', () => {
  it('resets, writes the history and screen without a final newline, then the cursor', () => {
    const data = snapshotData(snap({ cursorX: 3, cursorY: 1 }, ['1', `${ESC}[31m2`, 'x']))
    expect(data).toBe(`${ESC}c1\r\n${ESC}[31m2\r\nx${ESC}[0m${ESC}[?2004h${ESC}[2;4H`)
  })

  it('hides the cursor when the pane did', () => {
    expect(after(snapshotData(snap({ cursorVisible: false })))).toBe(`${ESC}[?25l${ESC}[?2004h${ESC}[1;1H`)
  })

  it('sets each mode the pane has', () => {
    const modes: [Partial<PaneState>, string][] = [
      [{ origin: true }, `${ESC}[?6h`],
      [{ wrap: false }, `${ESC}[?7l`],
      [{ insert: true }, `${ESC}[4h`],
      [{ keypad: true }, `${ESC}=`],
      [{ keypadCursor: true }, `${ESC}[?1h`],
      [{ mouseStandard: true }, `${ESC}[?1000h`],
      [{ mouseButton: true }, `${ESC}[?1002h`],
      [{ mouseAll: true }, `${ESC}[?1003h`],
      [{ mouseSgr: true }, `${ESC}[?1006h`],
      [{ mouseUtf8: true }, `${ESC}[?1005h`],
    ]
    for (const [state, seq] of modes) expect(after(snapshotData(snap(state)))).toBe(`${seq}${ESC}[?2004h${ESC}[1;1H`)
  })

  it('sets a scroll region that is not the whole screen, before the cursor', () => {
    expect(after(snapshotData(snap({ scrollTop: 2, scrollBottom: 7, cursorY: 4 })))).toBe(
      `${ESC}[3;8r${ESC}[?2004h${ESC}[5;1H`,
    )
  })

  it('places the cursor relative to the scroll region in origin mode', () => {
    expect(after(snapshotData(snap({ origin: true, scrollTop: 2, scrollBottom: 7, cursorX: 1, cursorY: 4 })))).toBe(
      `${ESC}[3;8r${ESC}[?6h${ESC}[?2004h${ESC}[3;2H`,
    )
  })

  it('writes the saved screen, then switches to the alternate one from the saved cursor', () => {
    const data = snapshotData(
      snap({ alternate: true, altSavedX: 2, altSavedY: 1, cursorX: 5, cursorY: 3 }, ['n1', 'n2'], ['a1', 'a2']),
    )
    expect(data).toBe(
      `${ESC}cn1\r\nn2${ESC}[0m${ESC}[2;3H${ESC}[?1049h${ESC}[Ha1\r\na2${ESC}[0m${ESC}[?2004h${ESC}[4;6H`,
    )
  })

  it('does not move the cursor before switching when the saved cursor is unset', () => {
    const data = snapshotData(snap({ alternate: true }, ['n'], ['a']))
    expect(data).toBe(`${ESC}cn${ESC}[0m${ESC}[?1049h${ESC}[Ha${ESC}[0m${ESC}[?2004h${ESC}[1;1H`)
  })
})

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const socket = `mm-test-snap-${process.pid}-${Date.now()}`

/** Polls `check` until it is true, failing after `ms`. */
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const tmux = (...args: string[]): Promise<string> => run('tmux', ['-L', socket, ...args])

/** A 40x10 session running `command`, once its screen shows `ready`. */
async function session(name: string, command: string, ready: string): Promise<void> {
  await tmux('-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', '40', '-y', '10', command)
  const deadline = Date.now() + 5000
  while (!(await tmux('capture-pane', '-p', '-t', `=${name}:`)).includes(ready)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${ready}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Takes a snapshot of the session through a control client, as the terminal will. */
async function snapshotOf(name: string): Promise<Snapshot> {
  const env = { ...process.env }
  delete env.TMUX
  const proc = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', `=${name}`], { stdio: 'pipe', env })
  try {
    const replies: Extract<ControlEvent, { kind: 'reply' }>[] = []
    const p = new ControlParser((e) => {
      if (e.kind === 'reply') replies.push(e)
    })
    proc.stdout.on('data', (chunk: Buffer) => p.feed(chunk))
    await until(() => replies.some((r) => !r.ours), 'the attach block')
    proc.stdin.write(`${snapshotCommand(`=${name}:`)}\n`)
    const ours = (): typeof replies => replies.filter((r) => r.ours)
    await until(() => ours().length >= SNAPSHOT_REPLIES, 'the snapshot replies')
    expect(ours().every((r) => r.ok)).toBe(true)
    const s = parseSnapshot(ours().map((r) => r.lines))
    if (!s) throw new Error('malformed snapshot')
    return s
  } finally {
    proc.kill()
  }
}

/** A 40x10 xterm showing the snapshot. */
async function show(s: Snapshot): Promise<Terminal> {
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(snapshotData(s), resolve))
  return term
}

/** The rows on xterm's screen, without trailing spaces. */
const screen = (term: Terminal): string[] => {
  const b = term.buffer.active
  return Array.from({ length: term.rows }, (_, y) =>
    (b.getLine(b.viewportY + y)?.translateToString(true) ?? '').trimEnd(),
  )
}

const line = (term: Terminal, y: number): string =>
  term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? ''

describe.skipIf(!hasTmux)('snapshot of a real tmux pane', () => {
  afterAll(async () => {
    await tmux('kill-server').catch(() => {})
    // tmux leaves the socket file behind when the server exits; remove it too.
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
  })

  it('shows the normal screen as tmux holds it, with the cursor, and the history in the scrollback', async () => {
    await session('mmsnap_n', `seq 1 30; printf '\\033[5;10Hx'; exec cat`, 'x')
    const term = await show(await snapshotOf('mmsnap_n'))
    const pane = (await tmux('capture-pane', '-p', '-t', '=mmsnap_n:')).split('\n').slice(0, 10)
    expect(screen(term)).toEqual(pane.map((l) => l.trimEnd()))
    expect(term.buffer.active.cursorX).toBe(10) // just after the 'x' printed at column 10 (1-based)
    expect(term.buffer.active.cursorY).toBe(4)
    expect(term.buffer.active.length).toBeGreaterThan(10)
    expect(line(term, 0)).toBe('1')
    term.dispose()
  })

  it('turns on only the mouse modes the program asked for', async () => {
    // tmux's mouse_any_flag is set by any mouse mode; 1003 (every motion reported) is its mouse_all_flag.
    await session('mmsnap_m', `printf '\\033[?1000h\\033[?1006hmouse'; exec cat`, 'mouse')
    const s = await snapshotOf('mmsnap_m')
    expect([s.state.mouseStandard, s.state.mouseButton, s.state.mouseAll, s.state.mouseSgr]).toEqual([
      true,
      false,
      false,
      true,
    ])
    const term = await show(s)
    expect(term.modes.mouseTrackingMode).toBe('vt200')
    term.dispose()
  })

  it('shows a pane on the alternate screen, and the saved screen and history once it leaves', async () => {
    await session('mmsnap_a', `seq 1 30; printf 'normal\\n'; printf '\\033[?1049h\\033[2;3Halt'; exec cat`, 'alt')
    const s = await snapshotOf('mmsnap_a')
    const term = await show(s)
    expect(term.buffer.active.type).toBe('alternate')
    expect(screen(term)[1]).toBe('  alt')
    expect(screen(term).filter((l) => l !== '')).toEqual(['  alt'])
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([5, 1])
    await new Promise<void>((resolve) => term.write(`${ESC}[?1049l`, resolve))
    expect(term.buffer.active.type).toBe('normal')
    expect(screen(term)).toEqual(['23', '24', '25', '26', '27', '28', '29', '30', 'normal', ''])
    expect(line(term, 0)).toBe('1')
    // Back where the program switched from: the start of the line after 'normal'.
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([0, 9])
    term.dispose()
  })
})
