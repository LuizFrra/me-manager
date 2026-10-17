import { execFile } from 'node:child_process'

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** Extra variables merged over process.env. */
  env?: NodeJS.ProcessEnv
  /** Non-zero exit codes that still count as success (e.g. 1 for `git diff --no-index` with differences). */
  okExitCodes?: number[]
}

/** Runs a binary without a shell and resolves with stdout. Rejects with CommandError. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const command = [file, ...args].join(' ')
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 0,
        maxBuffer: 16 * 1024 * 1024,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(String(stdout))
          return
        }
        const errno = (err as NodeJS.ErrnoException).code
        if (errno === 'ENOENT') {
          reject(new CommandError(command, null, '', `${file}: command not found on PATH`))
          return
        }
        const code = typeof err.code === 'number' ? err.code : null
        if (code !== null && opts.okExitCodes?.includes(code)) {
          resolve(String(stdout))
          return
        }
        const detail = String(stderr).trim() || `exit code ${code}`
        reject(new CommandError(command, code, String(stderr), `${command} failed: ${detail}`))
      },
    )
  })
}
