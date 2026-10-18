import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../../../shared/types'
import { ChangesList } from '../components/files/ChangesList'
import { FileTree } from '../components/files/FileTree'
import { buildTree } from '../lib/fileTree'

/**
 * A quick benchmark of the side panel's lists at repo scale. It checks how many rows are rendered (the point of
 * virtualizing), and prints the timings with PERF_REPORT=1:
 *   PERF_REPORT=1 npx vitest run src/renderer/src/perf --silent=false --reporter=verbose
 * Before virtualization (commit 7360af9), in jsdom on the dev machine: buildTree(50k) ~37 ms warm; the 20,000-file
 * tree, fully expanded, rendered all 20,440 rows in ~880 ms; 5,000 changes rendered 5,000 rows in ~490 ms. After:
 * ~25-29 ms, 38 rows in ~27 ms, and 38 rows in ~15 ms.
 */
const report = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PERF_REPORT

/** `n` paths, 1,000 per package, 50 per module folder: `pkg3/src/mod7/file3350.ts`. */
const makePaths = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `pkg${Math.floor(i / 1000)}/src/mod${Math.floor(i / 50) % 20}/file${i}.ts`)

const time = <T,>(fn: () => T): [T, number] => {
  const t = performance.now()
  const result = fn()
  return [result, performance.now() - t]
}

describe('large lists', () => {
  it('builds a 50,000-path tree and renders a fully expanded 20,000-file tree as a window of rows', () => {
    const paths50k = makePaths(50_000)
    buildTree(paths50k) // warm up
    const runs = Array.from({ length: 5 }, () => time(() => buildTree(paths50k))[1])
    const buildMs = runs.reduce((a, b) => a + b, 0) / runs.length

    const nodes = buildTree(makePaths(20_000))
    const [{ container }, renderMs] = time(() =>
      render(<FileTree nodes={nodes} badges={new Map()} isOpen={() => true} onToggle={() => {}} onSelect={() => {}} />),
    )
    const rows = container.querySelectorAll('.tree-row').length
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(100) // of 20,440 visible rows (20,000 files and 440 folders)

    const changes: ChangedFile[] = makePaths(5_000).map((path) => ({
      path,
      status: 'M',
      added: 1,
      removed: 1,
      binary: false,
    }))
    const [list, changesMs] = time(() => render(<ChangesList changes={changes} onSelect={() => {}} />))
    const changeRows = list.container.querySelectorAll('.change-row').length
    expect(changeRows).toBeLessThan(100)

    if (report)
      console.info(
        `buildTree(50k): ${buildMs.toFixed(1)} ms · FileTree(20k files, expanded): ${rows} rows in ${renderMs.toFixed(1)} ms · ChangesList(5k): ${changeRows} rows in ${changesMs.toFixed(1)} ms`,
      )
  }, 60_000)
})
