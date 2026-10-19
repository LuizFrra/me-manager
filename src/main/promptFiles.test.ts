import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { claudeContinueCommand, claudePromptCommand, promptArgument } from './app/orchestrator'
import { run } from './exec'
import { PromptFiles } from './promptFiles'
import { TmuxService } from './tmux/tmuxService'

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  for (let waited = 0; !(await check()) && waited < ms; waited += 50) await new Promise((r) => setTimeout(r, 50))
}

describe('PromptFiles', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mm-prompts-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('writes each prompt to a new file only the user can read, in a folder only the user can open', async () => {
    const dir = join(home, 'prompts')
    await mkdir(dir, { mode: 0o755 })
    await chmod(dir, 0o755) // an existing, looser folder is tightened
    const files = new PromptFiles(dir)
    const a = await files.write('é'.repeat(10_000))
    const b = await files.write("it's")
    expect(a).not.toBe(b)
    expect(a.startsWith(`${dir}/prompt-`)).toBe(true)
    await expect(readFile(a, 'utf8')).resolves.toBe('é'.repeat(10_000))
    await expect(readFile(b, 'utf8')).resolves.toBe("it's")
    expect((await stat(a)).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('removes a released file after the grace time, or right away', async () => {
    const files = new PromptFiles(join(home, 'prompts'), 100)
    const later = await files.write('a')
    const now = await files.write('b')
    files.release(later)
    files.release(now, true)
    await waitFor(() => !existsSync(now))
    expect(existsSync(now)).toBe(false)
    expect(existsSync(later)).toBe(true)
    await waitFor(() => !existsSync(later))
    expect(existsSync(later)).toBe(false)
  })

  it('sweeps prompt files older than the grace time, and nothing else', async () => {
    const dir = join(home, 'prompts')
    const files = new PromptFiles(dir, 60_000)
    await files.sweep() // no folder yet
    const old = await files.write('old')
    const fresh = await files.write('fresh')
    const other = join(dir, 'notes.txt')
    await writeFile(other, 'x')
    const past = new Date(Date.now() - 120_000)
    await utimes(old, past, past)
    await utimes(other, past, past)
    await files.sweep()
    expect((await readdir(dir)).sort()).toEqual([fresh.slice(dir.length + 1), 'notes.txt'].sort())
  })
})

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)

/** The prompt reaches `claude` from a real tmux window, through the command the orchestrator builds. */
describe.skipIf(!hasTmux)('Prompt files through tmux', () => {
  const socket = `mm-test-prompt-${process.pid}-${Date.now()}`
  const savedPath = process.env.PATH
  let dir: string
  let svc: TmuxService
  let files: PromptFiles
  let out: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-prompt-tmux-'))
    const bin = join(dir, 'bin')
    out = join(dir, 'args')
    await mkdir(bin)
    // Stands in for claude: records its arguments, NUL-separated, then fails a --continue like a first start does
    // or keeps running (so the session stays).
    await writeFile(
      join(bin, 'claude'),
      [
        '#!/bin/sh',
        `for a; do [ "$a" = --continue ] && { printf '%s\\0' "$@" > '${out}-continue'; exit 1; }; done`,
        `printf '%s\\0' "$@" > '${out}.tmp' && mv '${out}.tmp' '${out}'`,
        'exec sleep 60',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    // Before the server starts, so its windows find this claude first.
    process.env.PATH = `${bin}:${savedPath}`
    svc = new TmuxService(socket, join(dir, 'tmux.conf'))
    await svc.ensureConfig()
    files = new PromptFiles(join(dir, 'prompts'))
  })
  afterAll(async () => {
    process.env.PATH = savedPath
    await run('tmux', ['-L', socket, 'kill-server']).catch(() => {})
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
    await rm(dir, { recursive: true, force: true })
  })

  const argsOf = async (start: () => Promise<void>): Promise<string[]> => {
    await rm(out, { force: true })
    await rm(`${out}-continue`, { force: true })
    await start()
    await waitFor(() => existsSync(out))
    return (await readFile(out, 'utf8')).split('\0').slice(0, -1)
  }

  for (const [name, prompt] of [
    ['10,000 × é', 'é'.repeat(10_000)],
    ["10,000 × '", "'".repeat(10_000)],
    ['shell syntax', `$(touch '${'PWNED'}') \`id\` "q" ; | & * ~ #{session_name} \\`],
    ['a subcommand', 'mcp'],
  ]) {
    it(`starts claude with a prompt of ${name}, fresh or continuing`, async () => {
      const file = await files.write(promptArgument(prompt))
      const session = `mmt_prompt_${Math.random().toString(36).slice(2, 8)}`
      const words = await argsOf(() => svc.newSession(session, dir, 'claude', claudePromptCommand(['-x'], file)))
      expect(words).toEqual(['-x', '--', `${prompt} `])
      // --continue fails (no conversation yet), so the fallback gets the prompt too.
      const again = await argsOf(() => svc.newWindow(session, dir, 'claude', claudeContinueCommand(['-x'], file)))
      expect(again).toEqual(['-x', '--', `${prompt} `])
      const continued = (await readFile(`${out}-continue`, 'utf8')).split('\0').slice(0, -1)
      expect(continued).toEqual(['-x', '--continue', '--', `${prompt} `])
      files.release(file, true)
      await svc.killSession(session)
      expect(existsSync(join(dir, 'PWNED'))).toBe(false)
    })
  }
})
