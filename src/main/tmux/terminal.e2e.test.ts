// @vitest-environment jsdom
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { pause, TerminalHarness } from '../test/terminalHarness'
import { TmuxService } from './tmuxService'

/**
 * The terminal end to end: tmux with the app's config, a real client and xterm.js (see TerminalHarness). Each test
 * is a way the terminal went wrong once; what matters is what the user sees, so they check xterm's screen against
 * the pane tmux holds.
 */
const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const hasScript = existsSync('/usr/bin/script') || existsSync('/bin/script')
const socket = `mm-e2e-${process.pid}-${Date.now()}`
let svc: TmuxService
let cwd: string
let harness: TerminalHarness | null = null
let sessions = 0

/** A session running `command` (a shell command line), with a client attached. */
async function open(command: string): Promise<TerminalHarness> {
  const session = `mmt_e2e_${++sessions}`
  await svc.newSession(session, cwd, 'claude', command)
  harness = await TerminalHarness.attach(svc, socket, session)
  return harness
}

describe.skipIf(!hasTmux || !hasScript || process.platform !== 'linux')('terminal end to end', () => {
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mm-e2e-'))
    svc = new TmuxService(socket, join(cwd, 'tmux.conf'))
    await svc.ensureConfig()
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

  it('shows what the pane holds, wide characters (emoji, CJK) in the same cells as tmux', async () => {
    const t = await open(
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
    const go = join(cwd, 'go-select')
    const t = await open(`echo ready; while [ ! -e ${go} ]; do sleep 0.05; done; echo LATER OUTPUT; exec cat`)
    await t.until(() => t.screen()[0] === 'ready', 'the program to start')
    await t.drag(0, 0, 3)
    await t.until(() => t.raw.includes('\x1b]52;'), 'tmux to copy the selection (OSC 52)')
    await t.until(() => t.mode?.inCopyMode === false, 'tmux to leave copy mode')
    await writeFile(go, '')
    await t.until(() => t.screen().includes('LATER OUTPUT'), 'the later output to show')
    await t.showsPane()
  })

  it('says through the title how far the wheel scrolled back, and takes keys again once copy mode is left', async () => {
    const t = await open(`seq 1 200; exec cat`)
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
    const t = await open(`seq 1 200; exec cat`)
    await t.until(() => t.screen().includes('200'), 'the output')
    t.wheel('up')
    t.wheel('up')
    await t.until(() => (t.mode?.scrolledBack ?? 0) > 0, 'the view to scroll back')
    await t.drag(2, 0, 2)
    await t.until(() => t.raw.includes('\x1b]52;'), 'tmux to copy the selection')
    await pause(200)
    expect(t.mode?.inCopyMode).toBe(true)
  })

  it('passes 24-bit colour and OSC 8 links through to the terminal', async () => {
    const t = await open(
      `printf '\\033[38;2;255;100;0mRGB\\033[0m \\033]8;;https://a.dev/x\\033\\\\link\\033]8;;\\033\\\\\\n'; exec cat`,
    )
    await t.until(() => t.screen()[0] === 'RGB link', 'the output')
    const cell = t.term.buffer.active.getLine(0)?.getCell(0)
    expect(cell?.isFgRGB()).toBe(true)
    expect(cell?.getFgColor()).toBe(0xff6400)
    expect(t.raw).toContain('\x1b]8;')
    expect(t.raw).toContain('https://a.dev/x')
  })
})
