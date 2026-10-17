import { describe, expect, it } from 'vitest'
import { CommandError, run } from './exec'

describe('run', () => {
  it('returns stdout', async () => {
    await expect(run(process.execPath, ['-e', 'process.stdout.write("hi")'])).resolves.toBe('hi')
  })
  it('rejects with stderr on non-zero exit', async () => {
    const err = await run(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('boom')
    expect(err.code).toBe(3)
  })
  it('explains a missing binary', async () => {
    const err = await run('definitely-not-a-real-binary-xyz', []).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('not found')
  })
})
