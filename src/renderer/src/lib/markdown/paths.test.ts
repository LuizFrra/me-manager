import { describe, expect, it } from 'vitest'
import { headingSlug, isExternal, linkFragment, lineFragment, resolveRelative } from './paths'

describe('resolveRelative', () => {
  it('resolves a sibling file', () => {
    expect(resolveRelative('docs/a.md', 'b.md')).toBe('docs/b.md')
    expect(resolveRelative('docs/a.md', './b.md')).toBe('docs/b.md')
  })

  it('resolves parent paths and strips fragment and query', () => {
    expect(resolveRelative('docs/a.md', '../README.md#x')).toBe('README.md')
    expect(resolveRelative('docs/a.md', 'b.md?raw=1#y')).toBe('docs/b.md')
  })

  it('returns null when escaping the root', () => {
    expect(resolveRelative('a.md', '../../etc/passwd')).toBeNull()
    expect(resolveRelative('a.md', '../x.md')).toBeNull()
    expect(resolveRelative('docs/a.md', '/../x.md')).toBeNull()
  })

  it('catches traversal hidden behind percent-encoding', () => {
    expect(resolveRelative('a.md', '..%2F..%2Fetc%2Fpasswd')).toBeNull()
  })

  it('treats a leading slash as root-relative', () => {
    expect(resolveRelative('docs/deep/a.md', '/abs')).toBe('abs')
    expect(resolveRelative('docs/a.md', '/img/x.png')).toBe('img/x.png')
  })

  it('returns null for URLs with a scheme and for bare anchors', () => {
    expect(resolveRelative('a.md', 'mailto:me@example.com')).toBeNull()
    expect(resolveRelative('a.md', 'https://example.com/x.md')).toBeNull()
    expect(resolveRelative('a.md', 'javascript:alert(1)')).toBeNull()
    expect(resolveRelative('a.md', 'JaVaScRiPt:alert(1)')).toBeNull()
    expect(resolveRelative('a.md', 'data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(resolveRelative('a.md', 'file:///etc/passwd')).toBeNull()
    expect(resolveRelative('a.md', '//evil.example.com/x')).toBeNull()
    expect(resolveRelative('a.md', '#anchor')).toBeNull()
    expect(resolveRelative('a.md', '')).toBeNull()
  })

  it('decodes percent-escapes', () => {
    expect(resolveRelative('a.md', 'img%20one.png')).toBe('img one.png')
  })

  it('returns null for malformed escapes, NUL bytes and the root itself', () => {
    expect(resolveRelative('a.md', '%E0%A4%A')).toBeNull()
    expect(resolveRelative('a.md', 'a%00.md')).toBeNull()
    expect(resolveRelative('docs/a.md', '..')).toBeNull()
    expect(resolveRelative('a.md', './')).toBeNull()
  })
})

describe('isExternal', () => {
  it('accepts only http and https URLs', () => {
    expect(isExternal('http://example.com')).toBe(true)
    expect(isExternal('HTTPS://example.com/a?b#c')).toBe(true)
    expect(isExternal('mailto:me@example.com')).toBe(false)
    expect(isExternal('javascript:alert(1)')).toBe(false)
    expect(isExternal('file:///etc/passwd')).toBe(false)
    expect(isExternal('docs/a.md')).toBe(false)
    expect(isExternal('//example.com')).toBe(false)
    expect(isExternal('')).toBe(false)
  })
})

describe('linkFragment', () => {
  it("returns a link's decoded #fragment, or null without one", () => {
    expect(linkFragment('#Getting-started')).toBe('Getting-started')
    expect(linkFragment('b.md?x=1#caf%C3%A9')).toBe('café')
    expect(linkFragment('b.md')).toBeNull()
    expect(linkFragment('b.md#')).toBeNull()
    expect(linkFragment('#%E0%A4%A')).toBeNull()
  })
})

describe('lineFragment', () => {
  it('reads GitHub-style line anchors', () => {
    expect(lineFragment('L12')).toEqual({ start: 12, end: 12 })
    expect(lineFragment('L12-L20')).toEqual({ start: 12, end: 20 })
    expect(lineFragment('L12-20')).toEqual({ start: 12, end: 20 })
    expect(lineFragment('L20-L12')).toEqual({ start: 12, end: 20 })
    expect(lineFragment('L0')).toBeNull()
    expect(lineFragment('Lx')).toBeNull()
    expect(lineFragment('usage')).toBeNull()
    expect(lineFragment(null)).toBeNull()
  })
})

describe('headingSlug', () => {
  it("makes GitHub's anchor for a heading's text", () => {
    expect(headingSlug('Getting Started')).toBe('getting-started')
    expect(headingSlug('What’s new in v2.0?')).toBe('whats-new-in-v20')
    expect(headingSlug('API: `run()` & co')).toBe('api-run--co')
    expect(headingSlug('snake_case and-dash')).toBe('snake_case-and-dash')
    expect(headingSlug('Café über')).toBe('café-über')
  })
})
