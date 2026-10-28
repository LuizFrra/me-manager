// @vitest-environment jsdom
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { pause, TerminalHarness, type TerminalEngine } from '../test/terminalHarness'
import { TmuxService } from './tmuxService'

/**
 * The terminal end to end: tmux with the app's config, each of the terminal's engines and xterm.js (see
 * TerminalHarness). Each test is a way the terminal went wrong once, or could; what matters is what the user sees,
 * so they check xterm's screen against the pane tmux holds.
 */
const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const hasScript = existsSync('/usr/bin/script') || existsSync('/bin/script')
const hasPython = await run('python3', ['--version']).then(
  () => true,
  () => false,
)
const socket = `mm-e2e-${process.pid}-${Date.now()}`
let svc: TmuxService
let cwd: string
let harness: TerminalHarness | null = null
let sessions = 0

/**
 * A program that appends every byte it reads, unchanged (raw tty), to the file in argv[1]. It first turns on the
 * DEC private modes listed in argv[2] ('1000,1006'; '-' for none), and prints 'ready' once raw.
 */
const DUMPER = `import os, sys, tty
os.write(1, ''.join('\\x1b[?%sh' % m for m in sys.argv[2].split(',') if m != '-').encode())
tty.setraw(0)
os.write(1, b'ready\\r\\n')
with open(sys.argv[1], 'ab', buffering=0) as f:
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        f.write(data)
`

/**
 * A session running `command` (a shell command line), shown by `engine`. With `ready`, attaches once the pane holds
 * that text: what the program did before then reaches the terminal through the attach (a snapshot in direct mode).
 * `before` runs just before the attach.
 */
async function open(
  engine: TerminalEngine,
  command: string,
  {
    ready,
    cols,
    rows,
    before,
  }: { ready?: string; cols?: number; rows?: number; before?: (session: string) => Promise<void> } = {},
): Promise<TerminalHarness> {
  const session = `mmt_e2e_${++sessions}`
  await svc.newSession(session, cwd, 'claude', command)
  if (ready) {
    const pane = (): Promise<string> => run('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `=${session}:`])
    const end = Date.now() + 5000
    while (!(await pane()).includes(ready)) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${JSON.stringify(ready)} in the pane`)
      await pause(25)
    }
  }
  await before?.(session)
  harness = await TerminalHarness.attach(engine, svc, socket, session, { cols, rows })
  return harness
}

/** A dumper (see DUMPER) writing to a new file, with `modes` on; returns its command and what it has read. */
let dumpers = 0
function dumper(modes: string): { command: string; read: () => Promise<string> } {
  const file = join(cwd, `dump-${++dumpers}`)
  return {
    command: `exec python3 -I ${join(cwd, 'dump.py')} ${file} ${modes}`,
    read: () => readFile(file, 'utf8').catch(() => ''),
  }
}

describe.skipIf(!hasTmux || !hasScript || process.platform !== 'linux')('terminal end to end', () => {
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mm-e2e-'))
    svc = new TmuxService(socket, join(cwd, 'tmux.conf'))
    await svc.ensureConfig()
    await writeFile(join(cwd, 'dump.py'), DUMPER)
  })
  afterEach(async () => {
    await harness?.close()
    harness = null
  })
  afterAll(async () => {
    await run('tmux', ['-L', socket, 'kill-server']).catch(() => {})
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  describe.each(['classic', 'direct'] as const)('%s', (engine) => {
    it('shows what the pane holds, wide characters (emoji, CJK) in the same cells as tmux', async () => {
      const t = await open(
        engine,
        // ✅ and 🚀 take two cells for tmux (the system's wcwidth) but one in xterm's own Unicode 6 table. Text alone
        // would still read the same: what goes wrong is a later change to part of the line (as Claude Code's redraws
        // are), which tmux sends to the column it counted, so it lands elsewhere when the two disagree.
        `printf 'plain line\\na😀b after\\n✅ done 🚀 go\\n日本語x tail\\n✳ Claude ⏺ done\\n'; sleep 0.3; ` +
          `printf '\\0337\\033[3;12HGO\\0338'; exec cat`,
      )
      await t.until(() => t.raw.includes('GO'), 'the change')
      await t.showsPane()
      expect(t.screen().slice(0, 3)).toEqual(['plain line', 'a😀b after', '✅ done 🚀 GO'])
    })

    it('keeps showing new output after a mouse selection on the live screen', async () => {
      const go = join(cwd, `go-select-${engine}`)
      const t = await open(engine, `echo ready; while [ ! -e ${go} ]; do sleep 0.05; done; echo LATER OUTPUT; exec cat`)
      await t.until(() => t.screen()[0] === 'ready', 'the program to start')
      await t.drag(0, 0, 3)
      if (engine === 'classic') {
        await t.until(() => t.raw.includes('\x1b]52;'), 'tmux to copy the selection (OSC 52)')
        await t.until(() => t.mode?.inCopyMode === false, 'tmux to leave copy mode')
      } else {
        // The program didn't ask for the mouse: the selection is xterm's own, tmux hears nothing of it.
        expect(t.sent).toBe('')
      }
      await writeFile(go, '')
      await t.until(() => t.screen().includes('LATER OUTPUT'), 'the later output to show')
      await t.showsPane()
    })

    it('passes 24-bit colour and OSC 8 links through to the terminal', async () => {
      const t = await open(
        engine,
        `printf '\\033[38;2;255;100;0mRGB\\033[0m \\033]8;;https://a.dev/x\\033\\\\link\\033]8;;\\033\\\\\\n'; exec cat`,
      )
      await t.until(() => t.screen()[0] === 'RGB link', 'the output')
      const cell = t.term.buffer.active.getLine(0)?.getCell(0)
      expect(cell?.isFgRGB()).toBe(true)
      expect(cell?.getFgColor()).toBe(0xff6400)
      expect(t.raw).toContain('\x1b]8;')
      expect(t.raw).toContain('https://a.dev/x')
    })

    it('sends typed keys to the program', async () => {
      const t = await open(engine, `echo ready; exec cat`)
      await t.until(() => t.screen()[0] === 'ready', 'the program to start')
      t.send('typed é😀\r')
      // The tty's echo, then cat's copy.
      await t.until(() => t.screen().filter((l) => l === 'typed é😀').length === 2, 'the program to get the keys')
      await t.showsPane()
      expect(t.warnings).toEqual([])
    })
  })

  describe('classic', () => {
    it('says through the title how far the wheel scrolled back, and takes keys again once copy mode is left', async () => {
      const t = await open('classic', `seq 1 200; exec cat`)
      await t.until(() => t.screen().includes('200'), 'the output')
      t.wheel('up')
      t.wheel('up')
      await t.until(() => (t.mode?.scrolledBack ?? 0) > 0, 'the title to say the view is scrolled back')
      expect(t.mode?.inCopyMode).toBe(true)
      expect(await svc.leaveCopyMode(t.session)).toBe(true)
      await t.until(() => t.mode?.inCopyMode === false, 'the title to say copy mode was left')
      t.send('typed after scrolling\r')
      await t.until(() => t.screen().some((l) => l === 'typed after scrolling'), 'the program to get the keys')
      await t.showsPane()
    })

    it('stays scrolled back (in copy mode) after a selection made there', async () => {
      const t = await open('classic', `seq 1 200; exec cat`)
      await t.until(() => t.screen().includes('200'), 'the output')
      t.wheel('up')
      t.wheel('up')
      await t.until(() => (t.mode?.scrolledBack ?? 0) > 0, 'the view to scroll back')
      await t.drag(2, 0, 2)
      await t.until(() => t.raw.includes('\x1b]52;'), 'tmux to copy the selection')
      await pause(200)
      expect(t.mode?.inCopyMode).toBe(true)
    })
  })

  describe('direct', () => {
    it('brings the history printed before the attach into the scrollback', async () => {
      const t = await open('direct', `seq 1 300; exec cat`, { ready: '300' })
      await t.showsPane()
      const buffer = t.term.buffer.active
      expect(buffer.length).toBeGreaterThan(t.term.rows)
      expect(buffer.getLine(0)?.translateToString(true)).toBe('1')
      expect(buffer.getLine(299)?.translateToString(true)).toBe('300')
    })

    it('shows the other window when the active window changes, and the first again when it changes back', async () => {
      const t = await open('direct', `echo first-window; exec cat`, { ready: 'first-window' })
      await t.showsPane()
      await svc.newWindow(t.session, cwd, 'w2', 'echo second-window; exec cat')
      await t.until(() => t.screen()[0] === 'second-window', 'the second window')
      await t.showsPane()
      await t.tmux('select-window', '-t', `=${t.session}:0`)
      await t.until(() => t.screen()[0] === 'first-window', 'the first window again')
      await t.showsPane()
      expect(t.warnings).toEqual([])
    })

    it('stays as it is while another session changes its windows and panes', async () => {
      const t = await open('direct', `seq 1 50; echo session-a; exec cat`, { ready: 'session-a' })
      await t.showsPane()
      const resets = (): number => t.raw.split('\x1bc').length - 1
      const before = resets()
      // tmux tells every control client about these, whichever session they are attached to.
      const other = `mmt_e2e_${++sessions}`
      await svc.newSession(other, cwd, 'claude', 'exec cat')
      await svc.newWindow(other, cwd, 'w2', 'exec cat')
      await t.tmux('select-window', '-t', `=${other}:0`)
      await t.tmux('kill-window', '-t', `=${other}:1`)
      await t.tmux('new-window', '-t', `=${other}:`, 'exec cat')
      await t.tmux('split-window', '-t', `=${other}:`, 'exec cat')
      await t.tmux('select-pane', '-t', `=${other}:.0`)
      // The notifications came before the echo of what is typed now.
      t.send('typed\r')
      await t.until(() => t.screen().filter((l) => l === 'typed').length === 2, 'the program to get the keys')
      expect(resets()).toBe(before)
      await t.showsPane()
      expect(t.warnings).toEqual([])
      await svc.killSession(other)
    })

    it('takes a pane left in copy mode out of it, so typed keys reach the program', async () => {
      // As the classic terminal's wheel scrolling leaves a pane, or a switch to direct while scrolled back.
      const tmux = (...args: string[]): Promise<string> => run('tmux', ['-L', socket, ...args])
      const t = await open('direct', `echo ready; exec cat`, {
        ready: 'ready',
        before: async (session) => {
          await tmux('copy-mode', '-t', `=${session}:`)
          expect((await tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_in_mode}')).trim()).toBe('1')
        },
      })
      t.send('typed\r')
      await t.until(() => t.screen().filter((l) => l === 'typed').length === 2, 'the program to get the keys')
      expect(await t.format('#{pane_in_mode}')).toBe('0')
      await t.showsPane()
      expect(t.warnings).toEqual([])
    })

    it('shows a program on the alternate screen as it is, and the normal screen once it leaves', async () => {
      await writeFile(join(cwd, 'numbers'), Array.from({ length: 100 }, (_, i) => `number ${i + 1}`).join('\n'))
      // LESS from the environment could hold -X (no alternate screen).
      const t = await open('direct', `echo before-less; LESS= LESSHISTFILE=- less numbers; exec cat`, {
        ready: 'number 23',
      })
      await t.showsPane()
      expect(t.term.buffer.active.type).toBe('alternate')
      t.send('q')
      await t.until(() => t.term.buffer.active.type === 'normal', 'the normal screen')
      await t.showsPane()
      expect(t.screen()[0]).toBe('before-less')
    })

    it.skipIf(!hasPython)('reports the mouse to a program that asked for it, and only to it', async () => {
      const asked = dumper('1000,1006')
      const t = await open('direct', asked.command, { ready: 'ready' })
      // The program's mouse modes came with the snapshot.
      expect(t.term.modes.mouseTrackingMode).toBe('vt200')
      await t.drag(3, 4, 4)
      await t.until(async () => (await asked.read()) === '\x1b[<0;5;4M\x1b[<0;5;4m', 'the click to reach the program')
      await t.close()

      // Without SGR (1006) the reports are in the old X10 encoding, which xterm emits on onBinary.
      const x10 = dumper('1000')
      const v = await open('direct', x10.command, { ready: 'ready' })
      await v.drag(3, 4, 4)
      await v.until(async () => (await x10.read()) === '\x1b[M %$\x1b[M#%$', 'the X10 click to reach the program')
      await v.close()

      const not = dumper('-')
      const u = await open('direct', not.command, { ready: 'ready' })
      expect(u.term.modes.mouseTrackingMode).toBe('none')
      await u.drag(3, 4, 8)
      u.send('x')
      await u.until(async () => (await not.read()) === 'x', 'the key to reach the program')
    })

    it.skipIf(!hasPython)('brackets a paste only for a program that asked for it', async () => {
      const asked = dumper('2004')
      const t = await open('direct', asked.command, { ready: 'ready' })
      t.paste('one\ntwo')
      await t.until(async () => (await asked.read()).length > 0, 'the paste')
      await pause(100)
      expect(await asked.read()).toBe('\x1b[200~one\rtwo\x1b[201~')
      await t.close()

      const not = dumper('-')
      const u = await open('direct', not.command, { ready: 'ready' })
      u.paste('one\ntwo')
      await u.until(async () => (await not.read()).length > 0, 'the paste')
      await pause(100)
      expect(await not.read()).toBe('one\rtwo')
      expect([...t.warnings, ...u.warnings]).toEqual([])
    })

    it('resizes the window with the terminal', async () => {
      const t = await open('direct', `trap 'stty size' WINCH; echo ready; while :; do sleep 0.05; done`, {
        ready: 'ready',
      })
      expect(await t.format('#{window_width}x#{window_height}')).toBe('80x24')
      t.resize(100, 30)
      await t.until(async () => (await t.format('#{window_width}x#{window_height}')) === '100x30', 'tmux to resize')
      await t.until(() => t.screen().includes('30 100'), 'the program to see the new size')
      await t.showsPane()
    })
  })
})
