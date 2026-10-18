import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from './fuzzy'

const score = (query: string, text: string): number => fuzzyMatch(query, text)?.score ?? -Infinity
const rank = (query: string, texts: string[]): string[] => fuzzyFilter(texts, query, (t) => t).map((r) => r.item)

describe('fuzzyMatch', () => {
  it('matches a subsequence, case-insensitively', () => {
    expect(fuzzyMatch('flb', 'fix login bug')).not.toBeNull()
    expect(fuzzyMatch('FLB', 'fix login bug')).not.toBeNull()
    expect(fuzzyMatch('readme', 'README.md')).not.toBeNull()
  })

  it('rejects characters that are missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'fix login bug')).toBeNull()
    expect(fuzzyMatch('bl', 'fix login bug')).toBeNull()
    expect(fuzzyMatch('abc', 'ab')).toBeNull()
  })

  it('matches anything for an empty or blank query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('ignores whitespace in the query', () => {
    expect(fuzzyMatch('fix login', 'fixlogin')?.positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('returns the positions of the best placement', () => {
    // "app" could match a-p-p scattered across "a/map/app.ts", but the word start in "app.ts" wins.
    expect(fuzzyMatch('app', 'a/map/app.ts')?.positions).toEqual([6, 7, 8])
    expect(fuzzyMatch('flb', 'fix login bug')?.positions).toEqual([0, 4, 10])
  })

  it('scores consecutive matches above scattered ones', () => {
    expect(score('log', 'login')).toBeGreaterThan(score('log', 'lazy oak garden'.replace(/ /g, '')))
    expect(score('abc', 'xabcx')).toBeGreaterThan(score('abc', 'xaxbxcx'))
  })

  it('scores word starts above mid-word matches', () => {
    expect(score('lb', 'login-bug')).toBeGreaterThan(score('lb', 'allbutton'))
    expect(score('fb', 'fooBar')).toBeGreaterThan(score('fb', 'foobar'))
    expect(score('t', 'Theme › Task')).toBeGreaterThan(score('t', 'xtx'))
  })

  it('prefers shorter texts when everything else is equal', () => {
    expect(score('ab', 'ab')).toBeGreaterThan(score('ab', 'ab-long-suffix'))
  })
})

describe('fuzzyFilter', () => {
  it('keeps only matches, best first', () => {
    expect(rank('app', ['README.md', 'src/legacy/apple-pie.ts', 'src/app.ts', 'docs/a-p-p.md'])).toEqual([
      'src/app.ts',
      'src/legacy/apple-pie.ts',
      'docs/a-p-p.md',
    ])
  })

  it('ranks the task the user is typing above incidental matches', () => {
    const labels = ['Client X › my-api › fix login bug', 'Client X › notes', 'Personal › blog › new layout']
    expect(rank('login', labels)[0]).toBe('Client X › my-api › fix login bug')
    expect(rank('notes', labels)).toEqual(['Client X › notes'])
  })

  it('keeps the original order for ties and for an empty query', () => {
    expect(rank('a', ['xa', 'ya', 'za'])).toEqual(['xa', 'ya', 'za'])
    expect(rank('', ['c', 'b', 'a'])).toEqual(['c', 'b', 'a'])
  })

  it('applies the limit', () => {
    const items = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`)
    expect(fuzzyFilter(items, 'file', (t) => t, 50)).toHaveLength(50)
    expect(fuzzyFilter(items, '', (t) => t, 50)).toHaveLength(50)
  })

  it('returns the match positions with each item', () => {
    const [result] = fuzzyFilter([{ name: 'Toggle files panel' }], 'tfp', (i) => i.name)
    expect(result.item.name).toBe('Toggle files panel')
    expect(result.positions).toEqual([0, 7, 13])
  })
})
