import { describe, expect, it } from 'vitest'
import { isAppUrl, isHttpUrl } from './urls'

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true)
    expect(isHttpUrl('http://localhost:3000')).toBe(true)
  })
  it('rejects other schemes and garbage', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url', '']) {
      expect(isHttpUrl(url)).toBe(false)
    }
  })
})

describe('isAppUrl', () => {
  it('matches the dev server origin', () => {
    expect(isAppUrl('http://localhost:5173/?x#y', 'http://localhost:5173/')).toBe(true)
    expect(isAppUrl('https://evil.example/', 'http://localhost:5173/')).toBe(false)
  })
  it('matches only the same local file', () => {
    const app = 'file:///opt/me-manager/resources/app.asar/out/renderer/index.html'
    expect(isAppUrl(app + '#tab', app)).toBe(true)
    expect(isAppUrl('file:///etc/passwd', app)).toBe(false)
    expect(isAppUrl('https://example.com', app)).toBe(false)
  })
})
