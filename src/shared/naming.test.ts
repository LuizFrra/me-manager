import { describe, expect, it } from 'vitest'
import { branchName, sessionName, slugify, targetKey } from './naming'

describe('slugify', () => {
  it('lowercases and dashes words', () => {
    expect(slugify('Fix Login Bug!')).toBe('fix-login-bug')
  })
  it('strips accents', () => {
    expect(slugify('Ação Rápida')).toBe('acao-rapida')
  })
  it('trims leading and trailing separators', () => {
    expect(slugify('  --x--  ')).toBe('x')
  })
  it('returns empty string when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('')
  })
  it('truncates to 40 chars without a trailing dash', () => {
    const slug = slugify('a'.repeat(39) + ' bbbb')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('branchName', () => {
  it('namespaces by theme', () => {
    expect(branchName('client-x', 'fix-login-bug')).toBe('claude/client-x/fix-login-bug')
  })
})

describe('sessionName', () => {
  it('names task sessions', () => {
    expect(sessionName('client-x', 'my-api', 'fix-login-bug')).toBe('mmt_client-x_my-api_fix-login-bug')
  })
  it('names folder sessions so they cannot collide with task sessions', () => {
    expect(sessionName('client-x', 'notes')).toBe('mmf_client-x_notes')
  })
})

describe('targetKey', () => {
  it('uses the task id when present, otherwise the item id', () => {
    expect(targetKey({ themeId: 't', itemId: 'i', taskId: 'k' })).toBe('k')
    expect(targetKey({ themeId: 't', itemId: 'i' })).toBe('i')
  })
})
