import { describe, expect, it } from 'vitest'
import { checkCloneName, checkCloneUrl, cloneNameError, cloneNameFromUrl, cloneUrlError } from './clone'

describe('cloneUrlError', () => {
  it.each([
    'https://github.com/acme/my-api.git',
    'https://github.com/acme/my-api',
    'https://user@gitlab.example.com:8443/group/sub/repo.git',
    'ssh://git@github.com/acme/my-api.git',
    'ssh://git@host.example:2222/~/repo',
    'git@github.com:a/b.git',
    'deploy@10.0.0.5:/srv/git/repo.git',
    'file:///tmp/origin.git',
    'file://localhost/tmp/origin.git',
    '  https://github.com/acme/my-api.git  ',
  ])('accepts %s', (url) => {
    expect(cloneUrlError(url)).toBeNull()
  })

  it('refuses anything that git would read as an option', () => {
    expect(cloneUrlError('-u')).toMatch(/start with “-”/)
    expect(cloneUrlError('-uecho pwned')).toMatch(/start with “-”/)
    expect(cloneUrlError('--upload-pack=touch /tmp/x')).toMatch(/start with “-”/)
    expect(cloneUrlError('  -u')).toMatch(/start with “-”/)
    expect(cloneUrlError('ssh://-oProxyCommand=sh/x')).toMatch(/no valid host/)
    expect(cloneUrlError('git@host:-x')).toMatch(/path can’t start/)
  })

  it('refuses the ext:: and fd:: transports and other remote helpers', () => {
    expect(cloneUrlError('ext::sh -c touch% /tmp/pwned')).not.toBeNull()
    expect(cloneUrlError('ext::sh')).toMatch(/ext:: and fd::/)
    expect(cloneUrlError('fd::3')).toMatch(/ext:: and fd::/)
    expect(cloneUrlError('EXT::sh')).toMatch(/ext:: and fd::/)
    expect(cloneUrlError('persistent-https::https://x/y')).toMatch(/ext:: and fd::/)
  })

  it('refuses schemes outside the allowlist, bare paths and junk', () => {
    expect(cloneUrlError('http://github.com/a/b')).toMatch(/http:\/\/ URLs aren’t supported/)
    expect(cloneUrlError('git://github.com/a/b')).toMatch(/git:\/\/ URLs aren’t supported/)
    expect(cloneUrlError('/home/me/repo')).toMatch(/Use an https/)
    expect(cloneUrlError('github.com/a/b')).toMatch(/Use an https/)
    expect(cloneUrlError('')).toBe('Enter a repository URL')
    expect(cloneUrlError('   ')).toBe('Enter a repository URL')
    expect(cloneUrlError('https://github.com/a b')).toMatch(/spaces/)
    expect(cloneUrlError('https://github.com/a\nb')).toMatch(/spaces/)
    expect(cloneUrlError('https://github.com/')).toMatch(/no repository path/)
    expect(cloneUrlError('file://evil.example/x')).toMatch(/local path/)
    expect(cloneUrlError(`https://h/${'a'.repeat(2048)}`)).toMatch(/limited to 2048/)
  })

  it('checkCloneUrl trims, and throws the message for anything else', () => {
    expect(checkCloneUrl(' https://github.com/a/b ')).toBe('https://github.com/a/b')
    expect(() => checkCloneUrl('-u')).toThrow(/start with “-”/)
    expect(() => checkCloneUrl(42)).toThrow('Enter a repository URL')
  })
})

describe('cloneNameFromUrl', () => {
  it.each([
    ['https://github.com/acme/my-api.git', 'my-api'],
    ['https://github.com/acme/my-api', 'my-api'],
    ['https://github.com/acme/my-api/', 'my-api'],
    ['git@github.com:a/b.git', 'b'],
    ['git@github.com:repo.git', 'repo'],
    ['ssh://git@host:2222/~/tools.git', 'tools'],
    ['file:///tmp/x/origin.git', 'origin'],
    ['https://example.com/a/My%20Repo.git', 'My Repo'],
    ['', ''],
    ['https://github.com/', ''],
    ['https://github.com/a/..', ''],
  ])('%s → %s', (url, name) => {
    expect(cloneNameFromUrl(url)).toBe(name)
  })
})

describe('cloneNameError', () => {
  it('accepts plain names and refuses slashes, dot names and empty ones', () => {
    expect(cloneNameError('my-api')).toBeNull()
    expect(cloneNameError('My Repo.v2')).toBeNull()
    expect(cloneNameError('a/b')).toMatch(/“\/”/)
    expect(cloneNameError('..')).toMatch(/another folder name/)
    expect(cloneNameError('.')).toMatch(/another folder name/)
    expect(cloneNameError('  ')).toBe('Enter a folder name')
    expect(cloneNameError('a\0b')).toMatch(/control/)
    expect(cloneNameError('x'.repeat(201))).toMatch(/limited/)
    expect(checkCloneName(' my-api ')).toBe('my-api')
    expect(() => checkCloneName('../x')).toThrow(/“\/”/)
  })

  it('refuses .git in any case, and a name ending with a dot', () => {
    // .git would be read as the git folder of the clone's parent; Windows drops a trailing dot or space.
    for (const name of ['.git', '.GIT', '.Git', ' .git ']) expect(cloneNameError(name), name).toMatch(/“\.git”/)
    for (const name of ['repo.', 'repo..', 'repo. ', 'repo .']) expect(cloneNameError(name), name).toMatch(/end with/)
    expect(cloneNameError('.github')).toBeNull()
    expect(cloneNameError('repo.git')).toBeNull()
    expect(checkCloneName(' repo ')).toBe('repo')
    expect(cloneNameFromUrl('https://example.com/a/.git')).toBe('')
    expect(cloneNameFromUrl('https://example.com/a/repo..git')).toBe('')
  })
})
