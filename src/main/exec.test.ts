import { describe, expect, it } from 'vitest'
import { CommandError, run, streamNul } from './exec'

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
  it('merges extra env vars over process.env', async () => {
    const out = await run(
      process.execPath,
      ['-e', 'process.stdout.write(`${process.env.MM_X}:${!!process.env.PATH}`)'],
      {
        env: { MM_X: 'yes' },
      },
    )
    expect(out).toBe('yes:true')
  })
  it('resolves with stdout when the exit code is in okExitCodes', async () => {
    await expect(
      run(process.execPath, ['-e', "process.stdout.write('x'); process.exit(1)"], { okExitCodes: [1] }),
    ).resolves.toBe('x')
  })
  it('still rejects exit codes not in okExitCodes', async () => {
    const err = await run(process.execPath, ['-e', 'process.exit(2)'], { okExitCodes: [1] }).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.code).toBe(2)
  })
  it('explains a missing binary', async () => {
    const err = await run('definitely-not-a-real-binary-xyz', []).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('not found')
  })
  it('reports output over maxBuffer as too large', async () => {
    const err = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
      maxBuffer: 1024,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('output too large')
  })
})

describe('streamNul', () => {
  const node = (code: string): [string, string[]] => [process.execPath, ['-e', code]]

  it('yields NUL-separated items, including multi-byte characters split across chunks', async () => {
    const items: string[] = []
    const [file, args] = node(
      'const b = Buffer.from("a\\0çé\\0last\\0"); for (const x of b) process.stdout.write(Buffer.from([x]))',
    )
    await expect(streamNul(file, args, (item) => void items.push(item))).resolves.toEqual({ stopped: false })
    expect(items).toEqual(['a', 'çé', 'last'])
  })

  it('kills the process when onItem returns false', async () => {
    const items: string[] = []
    const [file, args] = node('setInterval(() => process.stdout.write("x\\0"), 1)')
    const res = await streamNul(file, args, (item) => items.push(item) < 5)
    expect(res).toEqual({ stopped: true })
    expect(items).toHaveLength(5)
  })

  it('rejects with stderr on a non-zero exit, and explains a missing binary', async () => {
    const [file, args] = node('console.error("boom"); process.exit(3)')
    const err = await streamNul(file, args, () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('boom')
    expect(err.code).toBe(3)
    const missing = await streamNul('definitely-not-a-real-binary-xyz', [], () => {}).catch((e) => e)
    expect(missing).toBeInstanceOf(CommandError)
    expect(missing.message).toContain('not found')
  })

  it('merges env over process.env and honors the timeout', async () => {
    const items: string[] = []
    const [file, args] = node('process.stdout.write(process.env.MM_X + "\\0")')
    await streamNul(file, args, (item) => void items.push(item), { env: { MM_X: 'yes' } })
    expect(items).toEqual(['yes'])
    const [slow, slowArgs] = node('setTimeout(() => {}, 10000)')
    const err = await streamNul(slow, slowArgs, () => {}, { timeoutMs: 100 }).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('timed out')
  })
})
