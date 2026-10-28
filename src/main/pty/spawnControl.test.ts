import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ControlProcess } from './controlTerminal'
import { spawnControl } from './spawnControl'

/** Everything the process prints, once it has exited. */
function output(proc: ControlProcess): Promise<string> {
  let out = ''
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
  return new Promise((resolve) => proc.on('exit', () => resolve(out)))
}

describe('spawnControl', () => {
  it('runs the command in cwd over pipes, without TMUX', async () => {
    const tmux = process.env.TMUX
    process.env.TMUX = '/tmp/tmux-1/default,1,0'
    const cwd = tmpdir()
    const proc = spawnControl({ file: 'sh', args: ['-c', 'printf "%s %s " "$(pwd)" "${TMUX-unset}"; cat'] }, cwd)
    if (tmux === undefined) delete process.env.TMUX
    else process.env.TMUX = tmux
    const done = output(proc)
    proc.stdin.end('typed')
    expect(await done).toBe(`${cwd} unset typed`)
  })

  it('reports an exit once killed', async () => {
    const proc = spawnControl({ file: 'cat', args: [] }, tmpdir())
    const done = output(proc)
    proc.kill()
    await expect(done).resolves.toBe('')
  })

  it("warns and reports an exit when the command can't start, instead of throwing", async () => {
    const warnings: string[] = []
    const proc = spawnControl({ file: '/nonexistent/tmux', args: [] }, tmpdir(), (m) => warnings.push(m))
    proc.stdin.on('error', () => {}) // as ControlTerminal does
    proc.stdin.write('refresh-client -C 80x24\n')
    let exits = 0
    await new Promise<void>((resolve) =>
      proc.on('exit', () => {
        exits++
        resolve()
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(exits).toBe(1)
    expect(warnings.join('\n')).toContain('ENOENT')
  })
})
