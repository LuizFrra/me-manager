import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { TmuxService } from './tmuxService'

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

  it('kills sessions and ignores missing ones', async () => {
    await svc.killSession('mmt_a_b_c')
    await expect(svc.hasSession('mmt_a_b_c')).resolves.toBe(false)
    await expect(svc.killSession('mmt_a_b_c')).resolves.toBeUndefined()
  })
})
