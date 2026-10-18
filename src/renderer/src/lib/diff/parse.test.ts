import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './parse'
import {
  ADDED_FILE,
  BINARY,
  DELETED_FILE,
  HEADER_LIKE_CONTENT,
  MULTI_HUNK,
  NO_NEWLINE,
  QUOTED_PATH,
  QUOTED_RENAME,
  OMITTED_COUNTS,
  RENAME_ONLY,
  SINGLE_HUNK,
  SPACE_IN_PATH,
  UNTRACKED_NO_INDEX,
} from './fixtures'

describe('parseUnifiedDiff', () => {
  it('parses a single hunk with line numbers', () => {
    const d = parseUnifiedDiff(SINGLE_HUNK)
    expect(d).toMatchObject({ binary: false, renamed: false, oldPath: 'single.txt', newPath: 'single.txt' })
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0].header).toBe('@@ -1,3 +1,3 @@')
    expect(d.hunks[0].lines).toEqual([
      { kind: 'context', text: 'alpha', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'beta', oldNo: 2 },
      { kind: 'add', text: 'BETA', newNo: 2 },
      { kind: 'context', text: 'gamma', oldNo: 3, newNo: 3 },
    ])
    expect(d.lineCount).toBe(4)
  })

  it('parses multiple hunks and restarts numbering at each header', () => {
    const d = parseUnifiedDiff(MULTI_HUNK)
    expect(d.hunks.map((h) => h.header)).toEqual(['@@ -1,6 +1,6 @@', '@@ -24,7 +24,7 @@ line 23'])
    const second = d.hunks[1].lines
    expect(second[0]).toEqual({ kind: 'context', text: 'line 24', oldNo: 24, newNo: 24 })
    expect(second[3]).toEqual({ kind: 'del', text: 'line 27', oldNo: 27 })
    expect(second[4]).toEqual({ kind: 'add', text: 'line twenty-seven', newNo: 27 })
    expect(second[7]).toEqual({ kind: 'context', text: 'line 30', oldNo: 30, newNo: 30 })
    expect(d.lineCount).toBe(15)
  })

  it('parses an added file (--- /dev/null)', () => {
    const d = parseUnifiedDiff(ADDED_FILE)
    expect(d.oldPath).toBeUndefined()
    expect(d.newPath).toBe('added.txt')
    expect(d.hunks[0].lines).toEqual([
      { kind: 'add', text: 'brand new', newNo: 1 },
      { kind: 'add', text: 'file', newNo: 2 },
    ])
  })

  it('parses a deleted file (+++ /dev/null)', () => {
    const d = parseUnifiedDiff(DELETED_FILE)
    expect(d.oldPath).toBe('gone.txt')
    expect(d.newPath).toBeUndefined()
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: 'to be deleted', oldNo: 1 },
      { kind: 'del', text: 'second', oldNo: 2 },
    ])
  })

  it('parses a rename with no content change', () => {
    const d = parseUnifiedDiff(RENAME_ONLY)
    expect(d).toEqual({
      binary: false,
      renamed: true,
      oldPath: 'old-name.txt',
      newPath: 'new-name.txt',
      hunks: [],
      lineCount: 0,
    })
  })

  it('flags binary diffs', () => {
    const d = parseUnifiedDiff(BINARY)
    expect(d.binary).toBe(true)
    expect(d.hunks).toEqual([])
    expect(d.lineCount).toBe(0)
  })

  it('keeps "no newline" notes without line numbers', () => {
    const d = parseUnifiedDiff(NO_NEWLINE)
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: 'no newline', oldNo: 1 },
      { kind: 'note', text: '\\ No newline at end of file' },
      { kind: 'add', text: 'no newline, changed', newNo: 1 },
      { kind: 'note', text: '\\ No newline at end of file' },
    ])
    expect(d.lineCount).toBe(4)
  })

  it('defaults omitted hunk counts to 1', () => {
    const d = parseUnifiedDiff(OMITTED_COUNTS)
    expect(d.hunks[0].header).toBe('@@ -1 +1 @@')
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: 'one', oldNo: 1 },
      { kind: 'add', text: 'uno', newNo: 1 },
    ])
  })

  it('returns no hunks for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({ binary: false, renamed: false, hunks: [], lineCount: 0 })
  })

  it('strips the trailing tab git adds to paths with spaces', () => {
    const d = parseUnifiedDiff(SPACE_IN_PATH)
    expect(d.oldPath).toBe('sp ace.txt')
    expect(d.newPath).toBe('sp ace.txt')
  })

  it('treats ---/+++ looking lines inside a hunk as content', () => {
    const d = parseUnifiedDiff(HEADER_LIKE_CONTENT)
    expect(d.oldPath).toBe('tricky.txt')
    expect(d.newPath).toBe('tricky.txt')
    expect(d.hunks[0].lines).toEqual([
      { kind: 'del', text: '-- header-like', oldNo: 1 },
      { kind: 'del', text: '++ plus-like', oldNo: 2 },
      { kind: 'add', text: '++ added-like', newNo: 1 },
      { kind: 'context', text: 'keep', oldNo: 3, newNo: 2 },
    ])
  })

  it('parses untracked-file output from git diff --no-index', () => {
    const d = parseUnifiedDiff(UNTRACKED_NO_INDEX)
    expect(d.oldPath).toBeUndefined()
    expect(d.newPath).toBe('untracked.txt')
    expect(d.hunks[0].lines[1]).toEqual({ kind: 'add', text: '<script>alert(1)</script>', newNo: 2 })
  })

  it('handles CRLF line endings in the diff text', () => {
    const d = parseUnifiedDiff(SINGLE_HUNK.replace(/\n/g, '\r\n'))
    expect(d.newPath).toBe('single.txt')
    expect(d.hunks[0].lines[1]).toEqual({ kind: 'del', text: 'beta', oldNo: 2 })
  })
  it('decodes git-quoted non-ASCII paths', () => {
    expect(parseUnifiedDiff(QUOTED_PATH)).toMatchObject({ oldPath: 'café.txt', newPath: 'café.txt' })
    expect(parseUnifiedDiff(QUOTED_RENAME)).toMatchObject({ renamed: true, oldPath: 'café.txt', newPath: 'naïve.txt' })
  })

  it('reads a bare empty line inside a hunk as an empty context line (diff.suppressBlankEmpty)', () => {
    const diff = [
      'diff --git a/blank.txt b/blank.txt',
      '--- a/blank.txt',
      '+++ b/blank.txt',
      '@@ -1,4 +1,4 @@',
      ' one',
      '',
      '-two',
      '+TWO',
      ' three',
      '',
    ].join('\n')
    const d = parseUnifiedDiff(diff)
    expect(d.hunks[0].lines).toEqual([
      { kind: 'context', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'context', text: '', oldNo: 2, newNo: 2 },
      { kind: 'del', text: 'two', oldNo: 3 },
      { kind: 'add', text: 'TWO', newNo: 3 },
      { kind: 'context', text: 'three', oldNo: 4, newNo: 4 },
    ])
    expect(d.lineCount).toBe(5)
  })
})
