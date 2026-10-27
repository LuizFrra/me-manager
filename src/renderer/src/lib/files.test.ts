import { describe, expect, it } from 'vitest'
import { folderIndex } from './files'

describe('folderIndex', () => {
  const paths = ['README.md', 'docs/Readme.MD', 'docs/a.md', 'docs/deep/README.md', 'site/index.md', 'src/app.ts']

  it("finds a folder's README (any case), else its index.md, directly inside it", () => {
    expect(folderIndex(paths, 'docs')).toBe('docs/Readme.MD')
    expect(folderIndex(paths, 'docs/deep')).toBe('docs/deep/README.md')
    expect(folderIndex(paths, 'site')).toBe('site/index.md')
    expect(folderIndex([...paths, 'site/README.markdown'], 'site')).toBe('site/README.markdown')
  })

  it('finds nothing for a folder without one, or a path that is no folder', () => {
    expect(folderIndex(paths, 'src')).toBeNull()
    expect(folderIndex(paths, 'src/app.ts')).toBeNull()
    expect(folderIndex(paths, 'nowhere')).toBeNull()
  })
})
