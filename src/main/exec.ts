import { execFile, spawn } from 'node:child_process'

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
    message: string,
    /** Set when the command was killed for running past its `timeoutMs`. */
    readonly timedOut = false,
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
  /** Largest stdout/stderr accepted by `run`, in bytes (default 16 MB). */
  maxBuffer?: number
  /** Written to the command's stdin, which is then closed (`run` only). */
  input?: string | Buffer
  /** Kills the command when it aborts, rejecting with the signal's reason (`run` and `streamNul`). */
  signal?: AbortSignal
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024
/**
 * How long `run` waits after its timeout's SIGTERM before killing the command outright (SIGKILL): an interactive
 * shell ignores SIGTERM, and the call would otherwise wait for it however long it runs.
 */
export const KILL_GRACE_MS = 1_000
const MAX_STDERR = 64 * 1024

const childEnv = (opts: RunOptions): NodeJS.ProcessEnv => (opts.env ? { ...process.env, ...opts.env } : process.env)

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('The command was cancelled')

/** Runs a binary without a shell and resolves with stdout. Rejects with CommandError. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const command = [file, ...args].join(' ')
  const { signal } = opts
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 0,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: childEnv(opts),
        signal,
      },
      (err, stdout, stderr) => {
        clearTimeout(forceKill)
        if (!err) {
          resolve(String(stdout))
          return
        }
        if (signal?.aborted) {
          reject(abortReason(signal))
          return
        }
        const errno = (err as NodeJS.ErrnoException).code
        if (errno === 'ENOENT') {
          reject(new CommandError(command, null, '', `${file}: command not found on PATH`))
          return
        }
        if (errno === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          const mb = Math.round((opts.maxBuffer ?? DEFAULT_MAX_BUFFER) / (1024 * 1024))
          reject(new CommandError(command, null, '', `${command} failed: output too large (over ${mb || '<1'} MB)`))
          return
        }
        if ((err as { killed?: boolean }).killed && opts.timeoutMs) {
          const after = `${Math.round(opts.timeoutMs / 100) / 10} s`
          reject(new CommandError(command, null, String(stderr), `${command} timed out after ${after}`, true))
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
    if (opts.timeoutMs) forceKill = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs + KILL_GRACE_MS)
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}) // EPIPE when the command exits without reading it; its exit code says why
      child.stdin?.end(opts.input)
    }
  })
}

/**
 * Runs a binary without a shell and resolves with the end of its stdout: all of it when it is at most `maxBytes`,
 * otherwise the whole lines in its last `maxBytes` bytes, with `truncated` set. For output that may be too large to
 * keep (where `run` would fail), and whose end matters most. Rejects with CommandError.
 */
export function runTail(
  file: string,
  args: string[],
  maxBytes: number,
  opts: Pick<RunOptions, 'cwd' | 'env' | 'timeoutMs'> = {},
): Promise<{ stdout: string; truncated: boolean }> {
  const command = [file, ...args].join(' ')
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: childEnv(opts), stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    let timedOut = false
    let stderr = ''
    // The newest chunks whose total is just over maxBytes: older ones are dropped as new ones arrive.
    const chunks: Buffer[] = []
    let kept = 0
    let dropped = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, opts.timeoutMs)
      : undefined
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      kept += chunk.length
      while (chunks.length > 1 && kept - chunks[0].length >= maxBytes) {
        kept -= chunks.shift()!.length
        dropped = true
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) =>
      settle(() =>
        reject(
          err.code === 'ENOENT'
            ? new CommandError(command, null, '', `${file}: command not found on PATH`)
            : new CommandError(command, null, stderr, `${command} failed: ${err.message}`),
        ),
      ),
    )
    child.on('close', (code) =>
      settle(() => {
        if (timedOut) return reject(new CommandError(command, null, stderr, `${command} timed out`, true))
        if (code !== 0) {
          const detail = stderr.trim() || `exit code ${code}`
          return reject(new CommandError(command, code, stderr, `${command} failed: ${detail}`))
        }
        let out = Buffer.concat(chunks)
        const truncated = dropped || out.length > maxBytes
        if (truncated) {
          out = out.subarray(Math.max(0, out.length - maxBytes))
          // Start at a line: the cut may have landed inside one, or inside a multi-byte character. With no line
          // break left (one huge line), at least skip the partial character (UTF-8 continuation bytes).
          const newline = out.indexOf(0x0a)
          let start = newline + 1
          if (newline === -1) while (start < out.length && (out[start] & 0xc0) === 0x80) start++
          out = out.subarray(start)
        }
        resolve({ stdout: out.toString('utf8'), truncated })
      }),
    )
  })
}

/**
 * Runs a binary without a shell and calls `onItem` with each NUL-terminated item of its stdout, decoded as UTF-8,
 * as it arrives (for output too large to buffer, like `git ls-files -z` in a huge repo). When `onItem` returns
 * false the process is killed and the promise resolves with `stopped: true`. Rejects with CommandError.
 */
export function streamNul(
  file: string,
  args: string[],
  onItem: (item: string) => boolean | void,
  opts: Omit<RunOptions, 'maxBuffer'> = {},
): Promise<{ stopped: boolean }> {
  const command = [file, ...args].join(' ')
  const { signal } = opts
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: childEnv(opts), stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    let stopped = false
    let timedOut = false
    let stderr = ''
    let partial: Buffer[] = []
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, opts.timeoutMs)
      : undefined
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    function onAbort(): void {
      settle(() => {
        child.kill()
        reject(abortReason(signal as AbortSignal))
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const emit = (bytes: Buffer): void => {
      if (stopped || onItem(bytes.toString('utf8')) !== false) return
      stopped = true
      child.kill()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      let start = 0
      for (let i = chunk.indexOf(0); i !== -1 && !stopped; i = chunk.indexOf(0, start)) {
        const piece = chunk.subarray(start, i)
        emit(partial.length > 0 ? Buffer.concat([...partial, piece]) : piece)
        partial = []
        start = i + 1
      }
      if (!stopped && start < chunk.length) partial.push(chunk.subarray(start))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) =>
      settle(() =>
        reject(
          err.code === 'ENOENT'
            ? new CommandError(command, null, '', `${file}: command not found on PATH`)
            : new CommandError(command, null, stderr, `${command} failed: ${err.message}`),
        ),
      ),
    )
    child.on('close', (code) =>
      settle(() => {
        if (stopped) return resolve({ stopped: true })
        if (timedOut) return reject(new CommandError(command, null, stderr, `${command} timed out`, true))
        if (code === 0 || (code !== null && opts.okExitCodes?.includes(code))) {
          if (partial.length > 0) emit(Buffer.concat(partial)) // a last item without a terminator
          return resolve({ stopped })
        }
        const detail = stderr.trim() || `exit code ${code}`
        reject(new CommandError(command, code, stderr, `${command} failed: ${detail}`))
      }),
    )
  })
}
