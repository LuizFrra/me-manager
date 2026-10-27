import { describe, expect, it } from 'vitest'
import { allProfiles, DEFAULT_PROFILE_ID, effectiveProfileId, normalizeConfigDir, profileError } from './profiles'
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
  })
})
