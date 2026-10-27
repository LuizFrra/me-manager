import { describe, expect, it } from 'vitest'
import { CommandError, KILL_GRACE_MS, run, runTail, streamNul } from './exec'

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
  it('writes `input` to stdin', async () => {
    const script = 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(s))'
    await expect(run(process.execPath, ['-e', script], { input: 'é'.repeat(50_000) })).resolves.toBe('é'.repeat(50_000))
  })
  it('says when the command was killed for running past its timeout', async () => {
    const err = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 }).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.timedOut).toBe(true)
    expect(err.message).toMatch(/timed out after 0\.1 s$/)
  })
  it('kills a command that ignores the timeout’s SIGTERM (as an interactive shell does)', async () => {
    const started = Date.now()
    const ignoreTerm = 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000)'
    const err = await run(process.execPath, ['-e', ignoreTerm], { timeoutMs: 300 }).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(300 + KILL_GRACE_MS + 2000)
  })
  it('kills the command and rejects when its signal aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const result = run('sleep', ['30'], { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('quitting')), 50)
    await expect(result).rejects.toThrow('quitting')
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect(run('sleep', ['30'], { signal: AbortSignal.abort(new Error('before start')) })).rejects.toThrow(
      'before start',
    )
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

  it('kills the process and rejects when its signal aborts', async () => {
    const [file, args] = node('process.stdout.write("x\\0"); setInterval(() => {}, 1000)')
    const controller = new AbortController()
    const started = Date.now()
    const result = streamNul(file, args, () => controller.abort(new Error('superseded')), {
      signal: controller.signal,
    })
    await expect(result).rejects.toThrow('superseded')
    expect(Date.now() - started).toBeLessThan(5_000)
    const aborted = AbortSignal.abort(new Error('before start'))
    await expect(streamNul(file, args, () => {}, { signal: aborted })).rejects.toThrow('before start')
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
    expect(err.timedOut).toBe(true)
  })
})

describe('runTail', () => {
  const node = (code: string): [string, string[]] => [process.execPath, ['-e', code]]

  it('resolves with all of stdout when it fits', async () => {
    const [file, args] = node('process.stdout.write("one\\ntwo\\n")')
    await expect(runTail(file, args, 1024)).resolves.toEqual({ stdout: 'one\ntwo\n', truncated: false })
  })

  it('keeps the end of a larger output, from the start of a line, and says it was cut', async () => {
    // 2,000 lines of 10 bytes, written in many chunks; only the last ~1 KB is kept.
    const [file, args] = node(
      'for (let i = 0; i < 2000; i++) process.stdout.write(`line ${String(i).padStart(4, "0")}\\n`)',
    )
    const { stdout, truncated } = await runTail(file, args, 1024)
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(1024)
    const lines = stdout.split('\n')
    expect(lines.pop()).toBe('')
    expect(lines.at(-1)).toBe('line 1999')
    expect(lines.every((l) => /^line \d{4}$/.test(l))).toBe(true) // whole lines only
    expect(lines.length).toBeGreaterThan(90)
  })

  it('never splits a multi-byte character when it cuts', async () => {
    const [file, args] = node('for (let i = 0; i < 500; i++) process.stdout.write("éééé\\n")')
    const { stdout, truncated } = await runTail(file, args, 100)
    expect(truncated).toBe(true)
    expect(stdout).toMatch(/^(éééé\n)+$/)
    // One line longer than the cap: its end, from a whole character.
    const [one, oneArgs] = node('process.stdout.write("é".repeat(500))')
    const long = await runTail(one, oneArgs, 101)
    expect(long.truncated).toBe(true)
    expect(long.stdout).toBe('é'.repeat(50))
  })

  it('rejects with stderr on a non-zero exit, explains a missing binary and honors the timeout', async () => {
    const [file, args] = node('console.error("boom"); process.exit(3)')
    const err = await runTail(file, args, 1024).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('boom')
    expect(err.code).toBe(3)
    const missing = await runTail('definitely-not-a-real-binary-xyz', [], 1024).catch((e) => e)
    expect(missing.message).toContain('not found')
    const [slow, slowArgs] = node('setTimeout(() => {}, 10000)')
    const late = await runTail(slow, slowArgs, 1024, { timeoutMs: 100 }).catch((e) => e)
    expect(late).toBeInstanceOf(CommandError)
    expect(late.timedOut).toBe(true)
  })
})
