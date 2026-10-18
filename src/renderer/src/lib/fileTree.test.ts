import { describe, expect, it } from 'vitest'
import {
  ancestorDirs,
  buildTree,
  filterPaths,
  flattenTree,
  memoByIdentity,
  sameFileList,
  type TreeNode,
} from './fileTree'

const shape = (nodes: TreeNode[]): unknown[] =>
  nodes.map((n) => (n.dir ? { [n.name + '/']: shape(n.children) } : n.name))

describe('buildTree', () => {
  it('nests paths, dirs first, then files, case-insensitive alphabetical', () => {
    const tree = buildTree(['src/b.ts', 'README.md', 'src/A.ts', 'docs/guide.md', 'a.txt', 'src/lib/x.ts', 'Zeta/z'])
    expect(shape(tree)).toEqual([
      { 'docs/': ['guide.md'] },
      { 'src/': [{ 'lib/': ['x.ts'] }, 'A.ts', 'b.ts'] },
      { 'Zeta/': ['z'] },
      'a.txt',
      'README.md',
    ])
  })

  it('sets full paths on dirs and files', () => {
    const [src] = buildTree(['src/lib/x.ts'])
    expect(src).toMatchObject({ name: 'src', path: 'src', dir: true })
    expect(src.children[0]).toMatchObject({ name: 'lib', path: 'src/lib', dir: true })
    expect(src.children[0].children[0]).toEqual({ name: 'x.ts', path: 'src/lib/x.ts', dir: false, children: [] })
  })

  it('returns an empty list for no paths and ignores empty segments', () => {
    expect(buildTree([])).toEqual([])
    expect(shape(buildTree(['a//b']))).toEqual([{ 'a/': ['b'] }])
  })
})

describe('filterPaths', () => {
  const paths = ['src/App.tsx', 'src/lib/fileTree.ts', 'README.md']

  it('matches a case-insensitive substring of the full path', () => {
    expect(filterPaths(paths, 'app')).toEqual(['src/App.tsx'])
    expect(filterPaths(paths, 'LIB/')).toEqual(['src/lib/fileTree.ts'])
    expect(filterPaths(paths, 'src')).toEqual(['src/App.tsx', 'src/lib/fileTree.ts'])
  })

  it('returns everything for a blank query', () => {
    expect(filterPaths(paths, '')).toEqual(paths)
    expect(filterPaths(paths, '   ')).toEqual(paths)
  })
})

describe('ancestorDirs', () => {
  it('lists the parent directories of a path', () => {
    expect(ancestorDirs('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('c.ts')).toEqual([])
    expect(ancestorDirs(undefined)).toEqual([])
  })
})

describe('flattenTree', () => {
  const tree = buildTree(['src/lib/x.ts', 'src/a.ts', 'README.md', 'docs/guide.md'])
  const rows = (open: string[]): string[] =>
    flattenTree(tree, (dir) => open.includes(dir)).map((r) => `${'  '.repeat(r.depth)}${r.node.name}`)

  it('lists the rows top to bottom, descending into open directories only', () => {
    expect(rows([])).toEqual(['docs', 'src', 'README.md'])
    expect(rows(['src'])).toEqual(['docs', 'src', '  lib', '  a.ts', 'README.md'])
    expect(rows(['src', 'src/lib', 'docs'])).toEqual([
      'docs',
      '  guide.md',
      'src',
      '  lib',
      '    x.ts',
      '  a.ts',
      'README.md',
    ])
    // A closed parent hides an open child.
    expect(rows(['src/lib'])).toEqual(['docs', 'src', 'README.md'])
  })
})

describe('memoByIdentity', () => {
  it('computes once per argument identity', () => {
    let calls = 0
    const count = memoByIdentity((xs: readonly string[]) => (calls++, xs.length))
    const a = ['x', 'y']
    expect(count(a)).toBe(2)
    expect(count(a)).toBe(2)
    expect(calls).toBe(1)
    expect(count([...a])).toBe(2)
    expect(calls).toBe(2)
  })
})

describe('sameFileList', () => {
  it('compares the paths one by one, and the truncated flag', () => {
    const list = { paths: ['a', 'b'], truncated: false }
    expect(sameFileList(list, { paths: ['a', 'b'], truncated: false })).toBe(true)
    expect(sameFileList(list, { paths: ['a', 'c'], truncated: false })).toBe(false)
    expect(sameFileList(list, { paths: ['a'], truncated: false })).toBe(false)
    expect(sameFileList(list, { paths: ['a', 'b'], truncated: true })).toBe(false)
    expect(sameFileList(null, list)).toBe(false)
  })
})
