import { Worker } from 'node:worker_threads'

/** A match on one line: [1-based line number, start character, length in characters]. */
export type LineHit = [line: number, start: number, length: number]

export class SearchTimeoutError extends Error {
  constructor(ms: number) {
    super(`The search timed out after ${Math.round(ms / 100) / 10} s. Try a more specific search.`)
    this.name = 'SearchTimeoutError'
  }
}

/** A search given up for a newer one (its signal aborted). */
export class SearchCancelledError extends Error {
  constructor() {
    super('The search was replaced by a newer one')
    this.name = 'SearchCancelledError'
  }
}

/**
 * Plain JavaScript run in a worker thread: for each text, the first match of the pattern on every line, up to
 * `max` in all. A worker because a regular expression can backtrack for minutes on the wrong input, and only a
 * thread can be stopped then; in the main process it would freeze the whole app, terminal included.
 */
const WORKER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const re = new RegExp(workerData.source, workerData.flags)
parentPort.on('message', ({ texts, max }) => {
  let total = 0
  const out = texts.map((text) => {
    const hits = []
    if (total >= max) return hits
    const lines = text.split('\\n')
    for (let i = 0; i < lines.length && total < max; i++) {
      const raw = lines[i]
      const line = raw.endsWith('\\r') ? raw.slice(0, -1) : raw
      const m = re.exec(line)
      if (m !== null) {
        hits.push([i + 1, m.index, m[0].length])
        total++
      }
    }
    return hits
  })
  parentPort.postMessage(out)
})
`

/**
 * Finds a pattern's first match per line in a worker thread, so a search can be abandoned at its deadline.
 * The pattern must already compile (see searchPattern). close() stops the worker; call it when done.
 */
export class LineMatcher {
  private readonly worker: Worker
  private failure: Error | null = null

  constructor(
    pattern: RegExp,
    /** When the whole search must be done, in ms since the epoch. */
    private readonly deadline: number,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: pattern.source, flags: pattern.flags.replace(/[gy]/g, '') },
    })
    this.worker.on('error', (err) => (this.failure = err))
  }

  /**
   * The hits for each text, in order; at most `max` in all. Rejects with SearchTimeoutError past the deadline, and
   * with SearchCancelledError (stopping the worker) when `signal` aborts.
   */
  match(texts: string[], max: number, signal?: AbortSignal): Promise<LineHit[][]> {
    if (signal?.aborted) return Promise.reject(new SearchCancelledError())
    if (texts.length === 0 || max <= 0) return Promise.resolve(texts.map(() => []))
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.worker.off('message', onMessage)
        this.worker.off('error', onError)
        this.worker.off('exit', onExit)
      }
      const onMessage = (hits: LineHit[][]): void => {
        cleanup()
        resolve(hits)
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(new Error(`The search failed: ${err.message}`))
      }
      const onExit = (): void => {
        cleanup()
        reject(this.failure ? new Error(`The search failed: ${this.failure.message}`) : new Error('The search stopped'))
      }
      const onAbort = (): void => {
        cleanup()
        void this.worker.terminate()
        reject(new SearchCancelledError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(
        () => {
          cleanup()
          void this.worker.terminate()
          reject(new SearchTimeoutError(this.timeoutMs))
        },
        Math.max(0, this.deadline - this.now()),
      )
      this.worker.on('message', onMessage)
      this.worker.on('error', onError)
      this.worker.on('exit', onExit)
      this.worker.postMessage({ texts, max })
    })
  }

  close(): void {
    void this.worker.terminate()
  }
}
