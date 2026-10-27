import { describe, expect, it } from 'vitest'
import { mixedLineEndings, modeChangeText, parseUnifiedDiff } from './parse'
import {
  ADDED_FILE,
  BINARY,
  BINARY_ADDED,
  DELETED_FILE,
  EMPTY_ADDED,
  EMPTY_DELETED,
  FILE_TO_SYMLINK,
  LF_TO_CRLF,
  MODE_AND_CONTENT,
  MODE_ONLY,
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
    expect(mixedLineEndings(d)).toBe(false)
  })

  it('marks lines whose content ends with a carriage return, without it in their text', () => {
    const d = parseUnifiedDiff(LF_TO_CRLF)
    expect(d.hunks[0].lines).toEqual([
      { kind: 'context', text: 'keep', oldNo: 1, newNo: 1, cr: true },
      { kind: 'del', text: 'x', oldNo: 2 },
      { kind: 'del', text: 'y', oldNo: 3 },
      { kind: 'add', text: 'x', newNo: 2, cr: true },
      { kind: 'add', text: 'y', newNo: 3, cr: true },
    ])
    expect(mixedLineEndings(d)).toBe(true)
    // In a diff text with CRLF endings of its own, a CRLF line of the file ends with two.
    const both = parseUnifiedDiff(LF_TO_CRLF.replace(/\n/g, '\r\n'))
    expect(both.hunks[0].lines.map((l) => l.cr ?? false)).toEqual([true, false, false, true, true])
  })

  it('finds no mixed line endings in a file that uses CRLF throughout', () => {
    expect(mixedLineEndings(parseUnifiedDiff(SINGLE_HUNK.replace(/^([ +-][^+-].*)$/gm, '$1\r')))).toBe(false)
    expect(mixedLineEndings(parseUnifiedDiff(SINGLE_HUNK))).toBe(false)
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

  it('reads file modes and whether the file was added or deleted', () => {
    expect(parseUnifiedDiff(MODE_ONLY)).toMatchObject({ oldMode: '100644', newMode: '100755', hunks: [] })
    expect(parseUnifiedDiff(MODE_AND_CONTENT)).toMatchObject({ oldMode: '100644', newMode: '100755', lineCount: 3 })
    expect(parseUnifiedDiff(EMPTY_ADDED)).toMatchObject({ status: 'added', newMode: '100644', hunks: [] })
    expect(parseUnifiedDiff(EMPTY_DELETED)).toMatchObject({ status: 'deleted', oldMode: '100644', hunks: [] })
    expect(parseUnifiedDiff(BINARY_ADDED)).toMatchObject({ status: 'added', binary: true })
    expect(parseUnifiedDiff(ADDED_FILE).status).toBe('added')
    expect(parseUnifiedDiff(DELETED_FILE).status).toBe('deleted')
    expect(parseUnifiedDiff(SINGLE_HUNK)).not.toHaveProperty('status')
    expect(parseUnifiedDiff(SINGLE_HUNK)).not.toHaveProperty('oldMode')
  })

  it('reads a file replaced by a symlink as a type change, not as an addition', () => {
    const d = parseUnifiedDiff(FILE_TO_SYMLINK)
    expect(d).toMatchObject({ oldMode: '100644', newMode: '120000', lineCount: 3 })
    expect(d).not.toHaveProperty('status')
  })
})

describe('modeChangeText', () => {
  it('says how the mode changed, or null when it did not', () => {
    expect(modeChangeText(parseUnifiedDiff(MODE_ONLY))).toBe('Made executable (mode 100644 → 100755)')
    expect(modeChangeText({ oldMode: '100755', newMode: '100644' })).toBe('No longer executable (mode 100755 → 100644)')
    expect(modeChangeText(parseUnifiedDiff(FILE_TO_SYMLINK))).toBe(
      'Changed from a regular file to a symlink (mode 100644 → 120000)',
    )
    expect(modeChangeText({ oldMode: '100644', newMode: '100600' })).toBe('Mode changed (100644 → 100600)')
    expect(modeChangeText(parseUnifiedDiff(SINGLE_HUNK))).toBeNull()
    expect(modeChangeText(parseUnifiedDiff(EMPTY_ADDED))).toBeNull()
    expect(modeChangeText(parseUnifiedDiff(DELETED_FILE))).toBeNull()
  })
})
