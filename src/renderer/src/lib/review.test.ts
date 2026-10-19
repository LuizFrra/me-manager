import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diff/parse'
import {
  diffLinesRange,
  formatReview,
  REVIEW_INTRO,
  reviewLocation,
  selectedLinesLabel,
  type ReviewComment,
} from './review'

const comment = (c: Omit<ReviewComment, 'id' | 'tab'> & Partial<ReviewComment>): ReviewComment => ({
  id: 1,
  tab: 'files',
  ...c,
})

describe('reviewLocation', () => {
  it('names a line or a range of the file as it is now', () => {
    expect(reviewLocation({ path: 'README.md', lines: { start: 3, end: 3 } })).toBe('README.md:3')
    expect(reviewLocation({ path: 'src/app.ts', lines: { start: 12, end: 15 } })).toBe('src/app.ts:12-15')
  })

  it("names deleted lines by their number in the old version, as they aren't in the file any more", () => {
    expect(reviewLocation({ path: 'a.ts', removed: { start: 7, end: 7 } })).toBe('a.ts (removed line 7)')
    expect(reviewLocation({ path: 'a.ts', removed: { start: 7, end: 9 } })).toBe('a.ts (removed lines 7-9)')
    expect(reviewLocation({ path: 'a.ts', lines: { start: 7, end: 8 }, removed: { start: 7, end: 7 } })).toBe(
      'a.ts:7-8 (and removed line 7)',
    )
  })

  it('names the whole file when there are no lines', () => {
    expect(reviewLocation({ path: 'a.ts' })).toBe('a.ts')
  })
})

describe('formatReview', () => {
  it('lists every comment under its location, in the order they were made', () => {
    const text = formatReview([
      comment({ path: 'src/app.ts', lines: { start: 12, end: 15 }, note: 'Use a map here.' }),
      comment({ id: 2, path: 'README.md', lines: { start: 3, end: 3 }, note: '  Typo:\n"teh"  \n' }),
    ])
    expect(text).toBe(
      [REVIEW_INTRO, '', 'src/app.ts:12-15', 'Use a map here.', '', 'README.md:3', 'Typo:\n"teh"'].join('\n'),
    )
    expect(REVIEW_INTRO).toBe('Please address these review comments:')
  })

  it('is empty without comments', () => {
    expect(formatReview([])).toBe('')
  })
})

describe('diffLinesRange', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -10,4 +10,4 @@',
    ' keep',
    '-old one',
    '-old two',
    '+new one',
    '+new two',
    ' tail',
  ].join('\n')
  const lines = parseUnifiedDiff(diff).hunks[0].lines

  it('takes added and context lines by their new number, deleted lines by their old one', () => {
    expect(diffLinesRange(lines.slice(3, 5))).toEqual({ lines: { start: 11, end: 12 } })
    expect(diffLinesRange(lines.slice(1, 3))).toEqual({ removed: { start: 11, end: 12 } })
    expect(diffLinesRange(lines)).toEqual({ lines: { start: 10, end: 13 }, removed: { start: 11, end: 12 } })
    expect(diffLinesRange([lines[0]])).toEqual({ lines: { start: 10, end: 10 } })
  })

  it('ignores notes', () => {
    expect(diffLinesRange([{ kind: 'note', text: '\\ No newline at end of file' }])).toEqual({})
  })
})

describe('selectedLinesLabel', () => {
  it('says which lines are selected', () => {
    expect(selectedLinesLabel({ lines: { start: 4, end: 4 } })).toBe('Line 4')
    expect(selectedLinesLabel({ lines: { start: 4, end: 9 } })).toBe('Lines 4–9')
    expect(selectedLinesLabel({ removed: { start: 2, end: 2 } })).toBe('Removed line 2')
    expect(selectedLinesLabel({ lines: { start: 4, end: 5 }, removed: { start: 2, end: 3 } })).toBe(
      'Lines 4–5 and removed lines 2–3',
    )
  })
})
