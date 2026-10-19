import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { parseWindowActivity, tidyCapture, TMUX_TIMEOUT_MS, TmuxService } from './tmuxService'

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const socket = `mm-test-${process.pid}-${Date.now()}`
let svc: TmuxService
let cwd: string

describe.skipIf(!hasTmux)('TmuxService', () => {
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mm-tmux-'))
    // Set before the server starts so #() jobs (run by the server) see it; keeps the marker in our temp dir.
    process.env.MM_TEST_MARKER = join(cwd, 'PWNED')
    svc = new TmuxService(socket, join(cwd, 'tmux.conf'))
    await svc.ensureConfig()
  })
  afterAll(async () => {
    await run('tmux', ['-L', socket, 'kill-server']).catch(() => {})
    // tmux leaves the socket file behind when the server exits; remove it too.
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  it('lists no sessions before the server starts', async () => {
    await expect(svc.listSessions()).resolves.toEqual([])
    await expect(svc.hasSession('nope')).resolves.toBe(false)
    await expect(svc.windowActivity('claude')).resolves.toEqual({})
  })

  it('creates a session with a named first window', async () => {
    await svc.newSession('mmt_a_b_c', cwd, 'claude', 'sh')
    await expect(svc.hasSession('mmt_a_b_c')).resolves.toBe(true)
    await expect(svc.listSessions()).resolves.toContain('mmt_a_b_c')
    await expect(svc.listWindows('mmt_a_b_c')).resolves.toEqual([{ index: 0, name: 'claude', active: true }])
  })

  it('loads the app config without errors', async () => {
    // source-file exits non-zero on any invalid line in the config.
    await expect(run('tmux', ['-L', socket, 'source-file', join(cwd, 'tmux.conf')])).resolves.toBeDefined()
    await expect(run('tmux', ['-L', socket, 'show', '-gv', 'status'])).resolves.toBe('off\n')
  })

  it('matches session names exactly', async () => {
    await expect(svc.hasSession('mmt_a_b')).resolves.toBe(false)
  })

  it('adds, selects and kills windows', async () => {
    await svc.newWindow('mmt_a_b_c', cwd, 'shell')
    let tabs = await svc.listWindows('mmt_a_b_c')
    expect(tabs.map((t) => [t.name, t.active])).toEqual([
      ['claude', false],
      ['shell', true],
    ])
    await svc.selectWindow('mmt_a_b_c', 0)
    tabs = await svc.listWindows('mmt_a_b_c')
    expect(tabs[0].active).toBe(true)
    await svc.killWindow('mmt_a_b_c', 1)
    await expect(svc.listWindows('mmt_a_b_c')).resolves.toHaveLength(1)
  })

  it('builds an attach command on our socket', () => {
    const { file, args } = svc.attachCommand('mmt_a_b_c')
    expect(file).toBe('tmux')
    // -u: GUI launches (macOS Dock) have no UTF-8 locale, and tmux would print non-ASCII as '_'.
    expect(args).toEqual(['-L', socket, '-f', join(cwd, 'tmux.conf'), '-u', 'attach-session', '-t', '=mmt_a_b_c'])
  })

  it('does not expand tmux formats or run #() commands in the cwd', async () => {
    // tmux format-expands -c; #(cmd) would run a shell command and #S would become the session name.
    const marker = join(cwd, 'PWNED')
    const evil = join(cwd, 'x#(touch "$MM_TEST_MARKER")y C#Sharp ##')
    await mkdir(evil)
    const real = await realpath(evil)
    const pathOf = async (target: string): Promise<string> =>
      (await run('tmux', ['-L', socket, 'display', '-p', '-t', target, '#{pane_current_path}'])).trim()

    await svc.newSession('mmt_evil_x_y', evil, 'claude', 'sh')
    await svc.newWindow('mmt_evil_x_y', evil, 'shell')
    await new Promise((r) => setTimeout(r, 500)) // #() jobs run asynchronously
    expect(existsSync(marker)).toBe(false)
    await expect(pathOf('=mmt_evil_x_y:0')).resolves.toBe(real)
    await expect(pathOf('=mmt_evil_x_y:1')).resolves.toBe(real)
    await svc.killSession('mmt_evil_x_y')
  })

  it("reports each session's claude window activity in one call, and captures its screen", async () => {
    const before = Math.floor(Date.now() / 1000)
    await svc.newSession('mmt_act_x_y', cwd, 'claude', 'sh')
    await svc.newWindow('mmt_act_x_y', cwd, 'shell')
    await svc.newSession('mmf_act_shell', cwd, 'shell', 'sh') // no claude window: not reported
    const activity = await svc.windowActivity('claude')
    expect(Object.keys(activity).sort()).toEqual(['mmt_a_b_c', 'mmt_act_x_y'])
    expect(activity['mmt_act_x_y']).toBeGreaterThanOrEqual(before - 1)
    expect(activity['mmt_act_x_y']).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))

    // Output moves the activity time forward (tmux reports whole seconds).
    await new Promise((r) => setTimeout(r, 1100))
    await run('tmux', [
      '-L',
      socket,
      'send-keys',
      '-t',
      '=mmt_act_x_y:=claude',
      "printf 'Do you want to proceed?\\n'",
      'Enter',
    ])
    await new Promise((r) => setTimeout(r, 300))
    const later = await svc.windowActivity('claude')
    expect(later['mmt_act_x_y']).toBeGreaterThan(activity['mmt_act_x_y'])

    const screen = await svc.capturePane('mmt_act_x_y', 'claude')
    expect(screen).toMatch(/^Do you want to proceed\?$/m)
    await expect(svc.capturePane('mmt_act_x', 'claude')).resolves.toBeNull() // exact session names only
    await expect(svc.capturePane('mmf_act_shell', 'claude')).resolves.toBeNull()
    await svc.killSession('mmt_act_x_y')
    await svc.killSession('mmf_act_shell')
  })

  it('types text literally into a window, then presses Enter', async () => {
    // cat stands in for Claude: each line it reads (on Enter) lands in the file, exactly as typed.
    const out = join(cwd, 'typed.txt')
    await svc.newSession('mmt_send_x_y', cwd, 'shell', 'sh')
    await svc.newWindow('mmt_send_x_y', cwd, 'claude', `cat > '${out}'`)
    const texts = [
      'Please rebase this branch onto origin/main and resolve the conflicts in: a.ts, b c.ts',
      `-x $(touch PWNED) \`id\` "q" 'q' ~ * #{session_name} Enter C-c ; mid`,
      'ends with a semicolon;',
      'ends with an escaped semicolon\\;',
    ]
    for (const text of texts) await svc.sendText('mmt_send_x_y', 'claude', text)
    let typed = ''
    for (let i = 0; i < 50 && typed.split('\n').length <= texts.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
      typed = existsSync(out) ? await readFile(out, 'utf8') : ''
    }
    expect(typed).toBe(texts.map((t) => `${t}\n`).join(''))
    expect(existsSync(join(cwd, 'PWNED'))).toBe(false)
    // Exact names: no window named "clau", no session "mmt_send_x".
    await expect(svc.sendText('mmt_send_x_y', 'clau', 'x')).rejects.toThrow()
    await expect(svc.sendText('mmt_send_x', 'claude', 'x')).rejects.toThrow()
    await svc.killSession('mmt_send_x_y')
  })

  it("types text too long for a tmux command: 10,000 × é and 10,000 × '", async () => {
    // tmux refuses a command over ~16 KB, and quoting inflates both: they go through a paste buffer instead.
    const out = join(cwd, 'long.txt')
    const ready = join(cwd, 'long.ready')
    await svc.newSession('mmt_long_x_y', cwd, 'shell', 'sh')
    // Not canonical: a terminal's line editor would cut a line at 4 KB.
    await svc.newWindow('mmt_long_x_y', cwd, 'claude', `stty -icanon -echo; : > '${ready}'; cat > '${out}'`)
    for (let i = 0; i < 50 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50))
    const texts = ['é'.repeat(10_000), "'".repeat(10_000)]
    for (const text of texts) await svc.sendText('mmt_long_x_y', 'claude', text)
    let typed = ''
    for (let i = 0; i < 100 && typed.split('\n').length <= texts.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
      typed = existsSync(out) ? await readFile(out, 'utf8') : ''
    }
    expect(typed).toBe(texts.map((t) => `${t}\n`).join(''))
    // The paste buffers are gone again.
    await expect(run('tmux', ['-L', socket, 'list-buffers'])).resolves.toBe('')
    await svc.killSession('mmt_long_x_y')
  })

  it('pastes text without pressing Enter when asked, multi-line text included', async () => {
    // Not canonical, so cat passes on what it gets at once, Enter or not: a pressed Enter would show as a newline.
    const out = join(cwd, 'no-enter.txt')
    const ready = join(cwd, 'no-enter.ready')
    await svc.newSession('mmt_noenter_x_y', cwd, 'shell', 'sh')
    await svc.newWindow('mmt_noenter_x_y', cwd, 'claude', `stty -icanon -echo; : > '${ready}'; cat > '${out}'`)
    for (let i = 0; i < 50 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50))
    const text = 'Please address these review comments:\n\na.ts:3\nfix it'
    await svc.sendText('mmt_noenter_x_y', 'claude', text, { enter: false })
    let typed = ''
    for (let i = 0; i < 50 && typed.length < text.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
      typed = existsSync(out) ? await readFile(out, 'utf8') : ''
    }
    await new Promise((r) => setTimeout(r, 300)) // time for an Enter, if one were sent
    typed = await readFile(out, 'utf8')
    // tmux turns the newlines into carriage returns, which the terminal reads as newlines again (icrnl).
    expect(typed).toBe(text)
    await svc.killSession('mmt_noenter_x_y')
  })

  it('leaves copy mode before typing, so the text reaches the app', async () => {
    const out = join(cwd, 'copy-mode.txt')
    const ready = join(cwd, 'copy-mode.ready')
    await svc.newSession('mmt_copy_x_y', cwd, 'shell', 'sh')
    await svc.newWindow('mmt_copy_x_y', cwd, 'claude', `: > '${ready}'; cat > '${out}'`)
    for (let i = 0; i < 50 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50))
    const target = '=mmt_copy_x_y:=claude'
    // Scrolling back in the terminal puts the pane in copy mode, where keys and pastes go to tmux, not the app.
    await run('tmux', ['-L', socket, 'copy-mode', '-t', target])
    const inMode = async (): Promise<string> =>
      (await run('tmux', ['-L', socket, 'display', '-p', '-t', target, '#{pane_in_mode}'])).trim()
    await expect(inMode()).resolves.toBe('1')
    await svc.sendText('mmt_copy_x_y', 'claude', 'after copy mode')
    let typed = ''
    for (let i = 0; i < 50 && !typed.includes('\n'); i++) {
      await new Promise((r) => setTimeout(r, 100))
      typed = existsSync(out) ? await readFile(out, 'utf8') : ''
    }
    expect(typed).toBe('after copy mode\n')
    await expect(inMode()).resolves.toBe('0')
    await svc.killSession('mmt_copy_x_y')
  })

  it("captures a tab's whole scrollback as plain text, wrapped lines joined", async () => {
    await svc.newSession('mmt_hist_x_y', cwd, 'claude', 'sh')
    // More lines than the screen has rows, one far wider than the default 80 columns, and colours.
    const script = [
      "i=1; while [ $i -le 400 ]; do printf 'line %03d\\n' $i; i=$((i+1)); done",
      "printf '%0250d\\n' 7",
      "printf 'tail   \\n\\033[1;31mred\\033[0m done\\n'",
      'exec cat',
    ].join('; ')
    await svc.newWindow('mmt_hist_x_y', cwd, 'shell', script)
    await svc.newWindow('mmt_hist_x_y', cwd, '9', 'sh') // a window *named* 9, at index 2
    let text = ''
    for (let i = 0; i < 50 && !text.includes('red done'); i++) {
      await new Promise((r) => setTimeout(r, 100))
      text = (await svc.captureHistory('mmt_hist_x_y', 1, 1024 * 1024)).text
    }
    const lines = text.split('\n')
    expect(lines.pop()).toBe('') // ends with one newline: trailing blank lines are trimmed
    const numbered = lines.filter((l) => l.startsWith('line '))
    expect(numbered).toEqual(Array.from({ length: 400 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}`))
    expect(lines).toContain(`${'0'.repeat(249)}7`) // one line, not four 80-column rows
    expect(lines.slice(-2)).toEqual(['tail', 'red done']) // trailing spaces trimmed, no colour codes
    expect(text).not.toMatch(/\x1b/) // eslint-disable-line no-control-regex
    await expect(svc.captureHistory('mmt_hist_x_y', 1, 1024 * 1024)).resolves.toMatchObject({ truncated: false })

    // Over the cap: the most recent whole lines.
    const cut = await svc.captureHistory('mmt_hist_x_y', 1, 600)
    expect(cut.truncated).toBe(true)
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(600)
    expect(cut.text.endsWith('tail\nred done\n')).toBe(true)
    expect(cut.text.split('\n')[0]).toMatch(/^line \d{3}$/)

    // Exact targets only: no prefix-matched session, no window index 9 even though a window is named 9.
    await expect(svc.captureHistory('mmt_hist_x', 1, 1024)).rejects.toThrow()
    await expect(svc.captureHistory('mmt_hist_x_y', 9, 1024)).rejects.toThrow(/No tab 9/)
    await expect(svc.captureHistory('mmt_hist_x_y', 2, 1024)).resolves.toMatchObject({ truncated: false })
    await svc.killSession('mmt_hist_x_y')
  })

  it('kills sessions and ignores missing ones', async () => {
    await svc.killSession('mmt_a_b_c')
    await expect(svc.hasSession('mmt_a_b_c')).resolves.toBe(false)
    await expect(svc.killSession('mmt_a_b_c')).resolves.toBeUndefined()
  })
})

describe('TmuxService timeouts', () => {
  const savedPath = process.env.PATH
  let bin: string
  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'mm-tmux-hang-'))
    // A tmux that never answers (a wedged server).
    await writeFile(join(bin, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
  })
  afterAll(async () => {
    process.env.PATH = savedPath
    await rm(bin, { recursive: true, force: true })
  })

  it(`gives up on every tmux call after ${TMUX_TIMEOUT_MS / 1000} s by default, or the given time`, async () => {
    expect(TMUX_TIMEOUT_MS).toBe(10_000)
    const hung = new TmuxService('mm-never', join(bin, 'tmux.conf'), { timeoutMs: 200, enterDelayMs: 0 })
    process.env.PATH = `${bin}:${savedPath}`
    try {
      const started = Date.now()
      await expect(hung.listWindows('s')).rejects.toThrow(/timed out/)
      await expect(hung.sendText('s', 'claude', 'hi')).rejects.toThrow(/timed out/)
      await expect(hung.newSession('s', bin, 'claude', 'sh')).rejects.toThrow(/timed out/)
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('tidyCapture', () => {
  it('trims trailing spaces and trailing blank lines, and ends with one newline', () => {
    expect(tidyCapture('a  \n b\t\n\n  \n\n')).toBe('a\n b\n')
    expect(tidyCapture('\n\nfirst\n\nlast')).toBe('\n\nfirst\n\nlast\n') // leading and inner blanks stay
    expect(tidyCapture('  \n\n')).toBe('')
    expect(tidyCapture('')).toBe('')
  })
})

describe('parseWindowActivity', () => {
  it('keeps the named windows, the latest per session, and skips malformed lines', () => {
    const out = [
      'mmt_a_b_c\t100\tclaude',
      'mmt_a_b_c\t250\tclaude', // two windows named claude: the latest wins
      'mmt_a_b_c\t300\tshell',
      'mmf_t_notes\t200\tclaude',
      'mmf_t_odd\t400\tclaude\textra', // a name with a tab is not "claude"
      'broken line',
      'mmt_x_y_z\t\tclaude',
      '',
    ].join('\n')
    expect(parseWindowActivity(out, 'claude')).toEqual({ mmt_a_b_c: 250, mmf_t_notes: 200 })
  })
})
