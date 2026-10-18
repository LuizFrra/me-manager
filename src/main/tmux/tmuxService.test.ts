import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { parseWindowActivity, TmuxService } from './tmuxService'

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

  it('kills sessions and ignores missing ones', async () => {
    await svc.killSession('mmt_a_b_c')
    await expect(svc.hasSession('mmt_a_b_c')).resolves.toBe(false)
    await expect(svc.killSession('mmt_a_b_c')).resolves.toBeUndefined()
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
