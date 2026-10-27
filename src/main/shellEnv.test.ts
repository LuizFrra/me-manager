import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KILL_GRACE_MS } from './exec'
import { ensureUtf8Locale, loadLoginShellPath } from './shellEnv'

describe('loadLoginShellPath', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  /** A stand-in login shell: `body`, then the app's `-ilc` command with /login/bin first on PATH. */
  const fakeShell = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-shell-'))
    dirs.push(dir)
    const file = join(dir, 'shell')
    writeFileSync(file, `#!/bin/sh\n${body}\nPATH="/login/bin:$PATH" exec /bin/sh -c "$2"\n`)
    chmodSync(file, 0o755)
    return file
  }

  it('takes PATH from the login shell', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: fakeShell(''), PATH: '/usr/bin:/bin' }
    await loadLoginShellPath(env)
    expect(env.PATH).toBe(`/login/bin:${process.env.PATH}`)
  })
  it('gives a start-up file that reads input an end of file instead of waiting for it', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: fakeShell('read answer'), PATH: '/usr/bin:/bin' }
    const started = Date.now()
    await loadLoginShellPath(env, 5000)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(env.PATH).toMatch(/^\/login\/bin:/)
  })
  it('gives up on a shell that hangs and ignores SIGTERM (as interactive shells do), keeping PATH', async () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: fakeShell("trap '' TERM\nwhile :; do sleep 1; done"),
      PATH: '/usr/bin:/bin',
    }
    const started = Date.now()
    await loadLoginShellPath(env, 300)
    expect(Date.now() - started).toBeLessThan(300 + KILL_GRACE_MS + 2000)
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})

describe('ensureUtf8Locale', () => {
  it('sets LANG when no locale variable is set (macOS Dock launch)', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    ensureUtf8Locale(env)
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' })
  })
  it('replaces a non-UTF-8 LANG', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'C' }
    ensureUtf8Locale(env)
    expect(env.LANG).toBe('en_US.UTF-8')
  })
  it.each([
    [{ LANG: 'pt_BR.UTF-8' }],
    [{ LANG: 'de_DE.utf8' }],
    [{ LC_ALL: 'en_GB.UTF-8' }],
    [{ LC_CTYPE: 'UTF-8', LANG: 'C' }],
  ])('keeps existing UTF-8 settings: %o', (vars) => {
    const env: NodeJS.ProcessEnv = { ...vars }
    ensureUtf8Locale(env)
    expect(env).toEqual(vars)
  })
  it('defaults to process.env', () => {
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE }
    try {
      delete process.env.LANG
      delete process.env.LC_ALL
      delete process.env.LC_CTYPE
      ensureUtf8Locale()
      expect(process.env.LANG).toBe('en_US.UTF-8')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
