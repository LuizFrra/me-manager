import { describe, expect, it } from 'vitest'
import type { AppState, ProfileStatus } from '../../../shared/types'
import { targetProfile } from './profiles'

const profile = (id: string, name: string): ProfileStatus => ({
  id,
  name,
  configDir: `/h/${id}`,
  billing: 'own',
  isDefault: id === 'default',
  login: 'signedIn',
})
const profiles = [profile('default', 'Default'), profile('p-work', 'Work'), profile('p-home', 'Home')]
const state = (themeProfile?: string, taskProfile?: string): AppState => ({
  version: 1,
  themes: [
    {
      id: 't',
      name: 'Acme',
      slug: 'acme',
      ...(themeProfile ? { profileId: themeProfile } : {}),
      items: [
        {
          id: 'r',
          kind: 'repo',
          name: 'api',
          slug: 'api',
          path: '/code/api',
          tasks: [
            {
              id: 'k',
              name: 'fix',
              slug: 'fix',
              branch: 'b',
              worktreePath: '/wt/fix',
              baseRef: 'origin/main',
              createdAt: '2026-01-01T00:00:00.000Z',
              ...(taskProfile ? { profileId: taskProfile } : {}),
            },
          ],
        },
        { id: 'f', kind: 'folder', name: 'docs', slug: 'docs', path: '/docs' },
      ],
    },
  ],
})

describe('targetProfile', () => {
  it("is the task's, else the theme's, else Default", () => {
    const task = { themeId: 't', itemId: 'r', taskId: 'k' }
    expect(targetProfile(state(), profiles, task)?.name).toBe('Default')
    expect(targetProfile(state('p-work'), profiles, task)?.name).toBe('Work')
    expect(targetProfile(state('p-work', 'p-home'), profiles, task)?.name).toBe('Home')
    expect(targetProfile(state('p-work', 'p-home'), profiles, { themeId: 't', itemId: 'f' })?.name).toBe('Work')
    expect(targetProfile(state('p-work'), profiles, { themeId: 't' })?.name).toBe('Work')
  })

  it('falls back to Default for a profile no longer there, and is unknown without profiles', () => {
    expect(targetProfile(state('gone'), profiles, { themeId: 't' })?.name).toBe('Default')
    expect(targetProfile(state(), [], { themeId: 't' })).toBeUndefined()
    expect(targetProfile(state(), profiles, { themeId: 't', itemId: 'r', taskId: 'nope' })).toBeUndefined()
  })
})
