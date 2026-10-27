import { describe, expect, it } from 'vitest'
import {
  allProfiles,
  DEFAULT_PROFILE_ID,
  effectiveProfileId,
  normalizeConfigDir,
  normalizeProfiles,
  profileError,
} from './profiles'
import type { ClaudeProfile } from './types'

const work: ClaudeProfile = { id: 'p-work', name: 'Work', configDir: '/home/me/.claude-work', billing: 'company' }
const home: ClaudeProfile = { id: 'p-home', name: 'Home', configDir: '/home/me/.claude-home', billing: 'own' }

describe('allProfiles', () => {
  it('lists Default first, with its folder and billing, then the saved profiles', () => {
    expect(allProfiles({ profiles: [work, home], defaultProfileBilling: 'company' }, '/home/me/.claude')).toEqual([
      { id: DEFAULT_PROFILE_ID, name: 'Default', configDir: '/home/me/.claude', billing: 'company' },
      work,
      home,
    ])
    expect(allProfiles({ profiles: [], defaultProfileBilling: 'own' }, '/c')).toEqual([
      { id: 'default', name: 'Default', configDir: '/c', billing: 'own' },
    ])
  })
})

describe('effectiveProfileId', () => {
  const profiles = allProfiles({ profiles: [work, home], defaultProfileBilling: 'own' }, '/home/me/.claude')

  it('takes the task’s profile over the theme’s, and the theme’s over Default', () => {
    expect(effectiveProfileId(profiles, { profileId: 'p-work' }, { profileId: 'p-home' })).toEqual({
      id: 'p-home',
      fellBack: false,
    })
    expect(effectiveProfileId(profiles, { profileId: 'p-work' }, {})).toEqual({ id: 'p-work', fellBack: false })
    expect(effectiveProfileId(profiles, { profileId: 'p-work' })).toEqual({ id: 'p-work', fellBack: false })
    expect(effectiveProfileId(profiles, {}, {})).toEqual({ id: DEFAULT_PROFILE_ID, fellBack: false })
    // A task can choose Default in a theme that has another profile.
    expect(effectiveProfileId(profiles, { profileId: 'p-work' }, { profileId: 'default' })).toEqual({
      id: DEFAULT_PROFILE_ID,
      fellBack: false,
    })
  })

  it('falls back to Default for an id no profile has', () => {
    expect(effectiveProfileId(profiles, { profileId: 'gone' })).toEqual({ id: DEFAULT_PROFILE_ID, fellBack: true })
    expect(effectiveProfileId(profiles, { profileId: 'p-work' }, { profileId: 'gone' })).toEqual({
      id: DEFAULT_PROFILE_ID,
      fellBack: true,
    })
  })
})

describe('normalizeConfigDir', () => {
  it('drops trailing slashes and collapses repeated ones', () => {
    expect(normalizeConfigDir('/home/me/.claude-work/')).toBe('/home/me/.claude-work')
    expect(normalizeConfigDir('//home///me//x//')).toBe('/home/me/x')
    expect(normalizeConfigDir('/')).toBe('/')
    expect(normalizeConfigDir('///')).toBe('/')
  })
})

describe('profileError', () => {
  const others = allProfiles({ profiles: [work], defaultProfileBilling: 'own' }, '/home/me/.claude')

  it('accepts a named profile with an absolute folder no other profile has', () => {
    expect(profileError({ name: 'Home', configDir: '/home/me/.claude-home' }, others)).toBeNull()
  })

  it('refuses an empty name and a folder that isn’t absolute', () => {
    expect(profileError({ name: '  ', configDir: '/x' }, others)).toMatch(/name/i)
    expect(profileError({ name: 'Home', configDir: 'relative/dir' }, others)).toMatch(/absolute/i)
    expect(profileError({ name: 'Home', configDir: '' }, others)).toMatch(/absolute/i)
  })

  it('refuses a name another profile has, ignoring case and spaces, Default’s included', () => {
    expect(profileError({ name: ' work ', configDir: '/x' }, others)).toBe('Another account is named “Work”')
    expect(profileError({ name: 'DEFAULT', configDir: '/x' }, others)).toBe('Another account is named “Default”')
  })

  it('refuses a folder another profile has, Default’s included, also with a trailing slash', () => {
    expect(profileError({ name: 'Home', configDir: '/home/me/.claude-work' }, others)).toBe(
      '“Work” already uses this folder',
    )
    expect(profileError({ name: 'Home', configDir: '/home/me/.claude-work/' }, others)).toBe(
      '“Work” already uses this folder',
    )
    expect(profileError({ name: 'Home', configDir: '/home/me//.claude' }, others)).toBe(
      '“Default” already uses this folder',
    )
    expect(profileError({ name: 'Home', configDir: ' /home/me/.claude-work ' }, others)).toBe(
      '“Work” already uses this folder',
    )
  })

  it('refuses a NUL in the name or folder, and takes the folder trimmed', () => {
    expect(profileError({ name: 'Ho\0me', configDir: '/x' }, others)).toMatch(/name/i)
    expect(profileError({ name: 'Home', configDir: '/a\0b' }, others)).toMatch(/absolute/i)
    expect(profileError({ name: 'Home', configDir: '  /home/me/.claude-home/ ' }, others)).toBeNull()
  })

  it('refuses the root folder and a folder ending in ;, which tmux would cut short', () => {
    expect(profileError({ name: 'Home', configDir: '/' }, others)).toBe('Choose a folder other than /')
    expect(profileError({ name: 'Home', configDir: '//' }, others)).toBe('Choose a folder other than /')
    expect(profileError({ name: 'Home', configDir: '/home/me/x;' }, others)).toBe('A folder can’t end in ;')
    expect(profileError({ name: 'Home', configDir: '/home/me/x;/' }, others)).toBe('A folder can’t end in ;')
    expect(profileError({ name: 'Home', configDir: '/home/me/a;b' }, others)).toBeNull()
  })

  it('accepts only what normalizeProfiles keeps, as the Settings dialog saves it', () => {
    const cases = [
      ['Home', '/home/me/.claude-home'],
      [' Home ', '  /home/me//.claude-home/ '],
      ['', '/x'],
      ['  ', '/x'],
      ['A\0', '/x'],
      ['Home', ''],
      ['Home', '   '],
      ['Home', ' relative'],
      ['Home', '/a\0b'],
      ['Home', '/'],
      ['Home', ' // '],
      ['Home', '/home/me/x;'],
      ['Home', '/home/me/x;/'],
    ]
    for (const [name, configDir] of cases) {
      const kept = normalizeProfiles([{ id: 'p', name, configDir, billing: 'own' }])
      expect([name, configDir, kept.length]).toEqual([name, configDir, profileError({ name, configDir }, []) ? 0 : 1])
      if (kept.length) expect(kept[0]).toMatchObject({ name: name.trim(), configDir: '/home/me/.claude-home' })
    }
  })
})
