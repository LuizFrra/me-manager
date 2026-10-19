import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Target } from '../../shared/types'
import { run } from '../exec'
import { TmuxService } from '../tmux/tmuxService'
import { makeDeps } from './fakes'
import { Orchestrator } from './orchestrator'

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const socket = `mm-test-run-${process.pid}-${Date.now()}`
let dir: string
let tmux: TmuxService
let orch: Orchestrator
let folder: Target
const SESSION = 'mmf_client-x_site'

/** Polls `read` every 100 ms until `check` holds or 5 s have passed; returns its last value. */
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 50 && !check(value); i++) {
    await new Promise((r) => setTimeout(r, 100))
    value = await read()
  }
  return value
}

/** The run tab's screen and scrollback, by its id. */
async function runOutput(): Promise<string> {
  const id = (await tmux.listWindowActivity(SESSION)).find((w) => w.name === 'run')?.id
  return (id && (await tmux.captureTail(id, 200))) || ''
}

const runTab = async (): Promise<{ dead?: true } | undefined> =>
  (await orch.listTabs(folder)).find((t) => t.name === 'run')

// The orchestrator on a real tmux server (a private socket), for a folder. Its session is made here with `cat` in
// the claude window, and nothing here opens the target: that would start the real `claude`.
describe.skipIf(!hasTmux)('Run command and dev-server URLs on a real tmux server', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'mm-run-')))
    tmux = new TmuxService(socket, join(dir, 'tmux.conf'))
    await tmux.ensureConfig()
    await mkdir(join(dir, 'site'))
    const ctx = makeDeps({ tmux })
    orch = new Orchestrator(ctx.deps, { runGraceMs: 200 })
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    const itemId = (await orch.addFolder(themeId, join(dir, 'site'))).themes[0].items[0].id
    folder = { themeId, itemId }
    await tmux.newSession(SESSION, dir, 'claude', 'exec cat')
  })
  afterAll(async () => {
    await run('tmux', ['-L', socket, 'kill-server']).catch(() => {})
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('runs the command in a run tab, finds the URL it prints, stops, restarts and forgets a closed tab', async () => {
    const log = join(dir, 'runs.log')
    const runs = async (): Promise<number> =>
      (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
    const command = (port: number): string =>
      `echo started >> '${log}'; printf 'Local: http://127.0.0.1:%s/\\n' ${port}; exec cat`
    await orch.setRunCommand(folder.themeId, folder.itemId, command(4173))
    const tabs = await orch.startRun(folder)
    expect(tabs.map((t) => [t.name, t.active])).toEqual([
      ['claude', false],
      ['run', true],
    ])
    const out = await until(runOutput, (t) => /^Local:/m.test(t))
    expect(out).toContain(`$ ${command(4173)}`) // the header line, as typed
    expect(out).toMatch(/^Local: http:\/\/127\.0\.0\.1:4173\/$/m)
    const pane = async (format: string): Promise<string> =>
      (await run('tmux', ['-L', socket, 'display', '-p', '-t', `=${SESSION}:=run`, format])).trim()
    await expect(pane('#{pane_current_path}')).resolves.toBe(join(dir, 'site')) // in the folder
    await expect(pane('#{remain-on-exit}')).resolves.toBe('on')
    await expect(orch.getDevUrls(folder)).resolves.toEqual([{ url: 'http://127.0.0.1:4173/', index: 1, tab: 'run' }])

    // Run again only shows it.
    await orch.selectTab(folder, 0)
    expect((await orch.startRun(folder)).map((t) => t.name)).toEqual(['claude', 'run'])
    expect(await runs()).toBe(1)

    // Stop leaves the tab, with its output; Restart runs it again there.
    await orch.stopRun(folder)
    expect(await until(runTab, (t) => t?.dead === true)).toEqual(expect.objectContaining({ dead: true }))
    await expect(runOutput()).resolves.toMatch(/^Local: http:\/\/127\.0\.0\.1:4173\/$/m)
    await orch.restartRun(folder)
    expect((await runTab())?.dead).toBeUndefined()
    expect(await until(runs, (n) => n === 2)).toBe(2)

    // Restart while it runs, with an edited command: Ctrl-C, then respawn. The screen starts afresh, so the old
    // URL goes with it.
    await orch.setRunCommand(folder.themeId, folder.itemId, command(5000))
    await orch.restartRun(folder)
    expect(await until(runs, (n) => n === 3)).toBe(3)
    await until(runOutput, (t) => t.includes(':5000/'))
    const urls = await until(
      () => orch.getDevUrls(folder),
      (u) => u[0]?.url === 'http://127.0.0.1:5000/',
    )
    expect(urls).toEqual([{ url: 'http://127.0.0.1:5000/', index: 1, tab: 'run' }])

    await orch.closeTab(folder, 1)
    await expect(orch.getDevUrls(folder)).resolves.toEqual([])
  })
})
