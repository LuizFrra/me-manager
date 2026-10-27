import { effectiveProfileId } from '../../../shared/profiles'
import type { AppState, ProfileBilling, ProfileLogin, ProfileStatus } from '../../../shared/types'

/** A Claude profile's login state (ProfileLogin) in a few words. */
export const LOGIN_TEXT: Record<ProfileLogin, string> = {
  signedIn: 'Signed in',
  keyOrGateway: 'Uses a key or gateway',
  notSignedIn: 'Not signed in',
  unknown: 'Unknown (macOS Keychain)',
  folderMissing: 'Folder not found',
}

/** Who pays for a profile, as its select says it. */
export const BILLING_LABEL: Record<ProfileBilling, string> = {
  own: 'Billing: my account',
  company: 'Billing: my company',
}

/**
 * The profile a theme's or task's sessions start in (see effectiveProfileId): the task's, else the theme's, else
 * Default, skipping one no longer there (`fellBack`); undefined while the profiles aren't known (or the theme or
 * task isn't there).
 */
export function targetAccount(
  state: AppState,
  profiles: readonly ProfileStatus[],
  target: { themeId: string; itemId?: string; taskId?: string },
): { profile: ProfileStatus; fellBack: boolean } | undefined {
  const theme = state.themes.find((t) => t.id === target.themeId)
  if (!theme || profiles.length === 0) return undefined
  const item = theme.items.find((i) => i.id === target.itemId)
  const task = item?.kind === 'repo' && target.taskId ? item.tasks.find((t) => t.id === target.taskId) : undefined
  if (target.taskId && !task) return undefined
  const { id, fellBack } = effectiveProfileId(profiles, theme, task)
  const profile = profiles.find((p) => p.id === id)
  return profile && { profile, fellBack }
}

/** targetAccount's profile. */
export const targetProfile = (
  state: AppState,
  profiles: readonly ProfileStatus[],
  target: { themeId: string; itemId?: string; taskId?: string },
): ProfileStatus | undefined => targetAccount(state, profiles, target)?.profile
