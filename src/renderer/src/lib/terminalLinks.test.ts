import { describe, expect, it } from 'vitest'
import { findFilePaths, findUrls } from './terminalLinks'

const urls = (line: string): string[] => findUrls(line).map((l) => l.url)

describe('findUrls', () => {
  it('finds http(s) URLs with their positions', () => {
    const line = 'Docs at https://docs.anthropic.com/en/docs and http://localhost:5173/app?x=1#top'
    const found = findUrls(line)
    expect(found.map((l) => l.url)).toEqual(['https://docs.anthropic.com/en/docs', 'http://localhost:5173/app?x=1#top'])
    expect(line.slice(found[0].start, found[0].end)).toBe('https://docs.anthropic.com/en/docs')
  })

  it('leaves sentence punctuation and unbalanced brackets out', () => {
    expect(urls('See https://example.com/a.')).toEqual(['https://example.com/a'])
    expect(urls('(see https://example.com/a)')).toEqual(['https://example.com/a'])
    expect(urls('[link](https://example.com/b), next')).toEqual(['https://example.com/b'])
    expect(urls('"https://example.com/q?a=1"')).toEqual(['https://example.com/q?a=1'])
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
  })

  it('ignores other schemes, a scheme glued to a word and a bare scheme', () => {
    expect(urls('javascript:alert(1) file:///etc/passwd ftp://x.org')).toEqual([])
    expect(urls('xhttps://example.com')).toEqual([])
    expect(urls('https:// nothing')).toEqual([])
  })
})

describe('findFilePaths', () => {
  const files = new Set(['src/main/index.ts', 'package.json', 'README.md'])
  const root = '/home/u/wt/task'

  it('links files of the task, relative or absolute under its root, with a line number', () => {
    const line = '⏺ Update(src/main/index.ts) see /home/u/wt/task/package.json:12:3 and ./README.md:7.'
    const found = findFilePaths(line, root, files)
    expect(found).toEqual([
      { kind: 'file', start: 9, end: 26, path: 'src/main/index.ts' },
      expect.objectContaining({ path: 'package.json', line: 12 }),
      expect.objectContaining({ path: 'README.md', line: 7 }),
    ])
    const readme = found[2]
    expect(line.slice(readme.start, readme.end)).toBe('./README.md:7')
  })

  it('never links words that are not files of the task, or URLs', () => {
    expect(findFilePaths('e.g. v1.2 node.js src/other.ts /etc/passwd', root, files)).toEqual([])
    expect(findFilePaths('https://x.dev/package.json', root, files)).toEqual([])
    expect(findFilePaths('/home/u/wt/task-2/package.json', root, files)).toEqual([])
  })
})
