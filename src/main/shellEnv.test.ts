import { describe, expect, it } from 'vitest'
import { ensureUtf8Locale } from './shellEnv'

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
