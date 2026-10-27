import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './parse'
import { splitHunk, splitHunks, type SplitRow } from './split'
import { ADDED_FILE, DELETED_FILE, LF_TO_CRLF, MULTI_HUNK, NO_NEWLINE, SINGLE_HUNK } from './fixtures'

/** Rows as compact strings: `<left> | <right>`, each side `kind:no:text`, `·` for padding. */
function show(rows: SplitRow[]): string[] {
  const side = (c: SplitRow['left']): string => (c ? `${c.kind}:${c.no ?? ''}:${c.text}` : '·')
  return rows.map((r) => `${side(r.left)} | ${side(r.right)}`)
}

const hunksOf = (diff: string): ReturnType<typeof splitHunks> => splitHunks(parseUnifiedDiff(diff).hunks)

const diffOf = (header: string, body: string[]): string =>
  `diff --git a/f b/f\n--- a/f\n+++ b/f\n${header}\n${body.join('\n')}\n`

describe('splitHunk', () => {
  it('pairs a one-line replace and shows context on both sides with both line numbers', () => {
    const [hunk] = hunksOf(SINGLE_HUNK)
    expect(hunk.header).toBe('@@ -1,3 +1,3 @@')
    expect(show(hunk.rows)).toEqual([
      'context:1:alpha | context:1:alpha',
      'del:2:beta | add:2:BETA',
      'context:3:gamma | context:3:gamma',
    ])
  })

  it('pads the left side for a pure addition', () => {
    expect(show(hunksOf(ADDED_FILE)[0].rows)).toEqual(['· | add:1:brand new', '· | add:2:file'])
  })

  it('pads the right side for a pure deletion', () => {
    expect(show(hunksOf(DELETED_FILE)[0].rows)).toEqual(['del:1:to be deleted | ·', 'del:2:second | ·'])
  })

  it('pairs uneven replace blocks in order, padding the shorter side', () => {
    const diff = diffOf('@@ -1,6 +1,6 @@', ['-a', '-b', '-c', '+x', ' keep', '-d', '+y', '+z', '+w', ' end'])
    expect(show(hunksOf(diff)[0].rows)).toEqual([
      'del:1:a | add:1:x',
      'del:2:b | ·',
      'del:3:c | ·',
      'context:4:keep | context:2:keep',
      'del:5:d | add:3:y',
      '· | add:4:z',
      '· | add:5:w',
      'context:6:end | context:6:end',
    ])
  })

  it('starts a new block when a deletion follows additions', () => {
    const diff = diffOf('@@ -1,2 +1,2 @@', ['-a', '+x', '-b', '+y'])
    expect(show(hunksOf(diff)[0].rows)).toEqual(['del:1:a | add:1:x', 'del:2:b | add:2:y'])
  })

  it('keeps hunks apart, each with its own header and line numbers', () => {
    const hunks = hunksOf(MULTI_HUNK)
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1,6 +1,6 @@', '@@ -24,7 +24,7 @@ line 23'])
    expect(show(hunks[0].rows)[2]).toBe('del:3:line 3 | add:3:line three')
    expect(show(hunks[1].rows)).toContain('del:27:line 27 | add:27:line twenty-seven')
    expect(show(hunks[1].rows)[0]).toBe('context:24:line 24 | context:24:line 24')
    expect(hunks[1].rows).toHaveLength(7)
  })

  it("puts each side's no-newline note on its side, right after its line", () => {
    expect(show(hunksOf(NO_NEWLINE)[0].rows)).toEqual([
      'del:1:no newline | add:1:no newline, changed',
      'note::\\ No newline at end of file | note::\\ No newline at end of file',
    ])
  })

  it('puts a note on the new side only when only the new file lacks the newline', () => {
    const diff = diffOf('@@ -1,2 +1,2 @@', [' a', '-b', '-c', '+B', '\\ No newline at end of file'])
    expect(show(hunksOf(diff)[0].rows)).toEqual([
      'context:1:a | context:1:a',
      'del:2:b | add:2:B',
      '· | note::\\ No newline at end of file',
      'del:3:c | ·',
    ])
  })

  it('puts a note on the old side only, after a deletion in the middle of a block', () => {
    const diff = diffOf('@@ -1 +1,2 @@', ['-a', '\\ No newline at end of file', '+a', '+b'])
    expect(show(hunksOf(diff)[0].rows)).toEqual([
      'del:1:a | add:1:a',
      'note::\\ No newline at end of file | ·',
      '· | add:2:b',
    ])
  })

  it('puts a note after a context line on both sides', () => {
    const diff = diffOf('@@ -1,2 +1,2 @@', ['-a', '+A', ' last', '\\ No newline at end of file'])
    expect(show(hunksOf(diff)[0].rows)).toEqual([
      'del:1:a | add:1:A',
      'context:2:last | context:2:last',
      'note::\\ No newline at end of file | note::\\ No newline at end of file',
    ])
  })

  it("keeps each line's carriage return mark on its side", () => {
    const rows = hunksOf(LF_TO_CRLF)[0].rows
    expect(rows.map((r) => [r.left?.cr ?? false, r.right?.cr ?? false])).toEqual([
      [true, true],
      [false, true],
      [false, true],
    ])
  })

  it('gives an empty hunk no rows', () => {
    expect(splitHunk({ header: '@@ -0,0 +0,0 @@', lines: [] }).rows).toEqual([])
  })
})
