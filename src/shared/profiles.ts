import { PROFILE_BILLINGS, type ClaudeProfile, type ProfileBilling, type Settings } from './types'

/** The id of the Default profile: the folder the app has always used, which every theme gets unless told otherwise. */
export const DEFAULT_PROFILE_ID = 'default'

/** Profiles kept at most in Settings.profiles; normalizeProfiles drops the rest. */
export const MAX_PROFILES = 20

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A NUL can't be part of a path or a command-line argument. */
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('\0')

/**
 * An absolute folder in the form profiles are compared in: repeated slashes collapsed, no trailing one. String
 * operations only (the renderer uses it too); `.` and `..` are kept as typed.
 */
export const normalizeConfigDir = (dir: string): string => dir.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')

/** Every profile, Default first; Default's folder is `defaultDir` (CLAUDE_CONFIG_DIR or ~/.claude, from main). */
export function allProfiles(
  settings: Pick<Settings, 'profiles' | 'defaultProfileBilling'>,
  defaultDir: string,
): ClaudeProfile[] {
  const fallback = {
    id: DEFAULT_PROFILE_ID,
    name: 'Default',
    configDir: defaultDir,
    billing: settings.defaultProfileBilling,
  }
  return [fallback, ...settings.profiles]
}

/**
 * The profile a session starts in: the task's, else the theme's, else Default. An id no profile has (a removed
 * profile, a hand edit) falls back to Default, with `fellBack` set so the caller can say so.
 */
export function effectiveProfileId(
  profiles: readonly ClaudeProfile[],
  theme: { profileId?: string },
  task?: { profileId?: string },
): { id: string; fellBack: boolean } {
  const id = task?.profileId ?? theme.profileId ?? DEFAULT_PROFILE_ID
  return profiles.some((p) => p.id === id) ? { id, fellBack: false } : { id: DEFAULT_PROFILE_ID, fellBack: true }
}

/**
 * Why a new or edited profile is refused, or null: an empty name, a folder that isn't absolute, or one that another
 * profile (`others`, Default included and the edited one left out) already uses, once normalized.
 */
export function profileError(
  p: Pick<ClaudeProfile, 'name' | 'configDir'>,
  others: readonly ClaudeProfile[],
): string | null {
  if (p.name.trim() === '') return 'Enter a name'
  if (!p.configDir.startsWith('/')) return 'Choose an absolute folder (starting with /)'
  const dir = normalizeConfigDir(p.configDir)
  const owner = others.find((o) => normalizeConfigDir(o.configDir) === dir)
  return owner ? `“${owner.name}” already uses this folder` : null
}

/**
 * Settings.profiles from untrusted input: entries with an id and a name (trimmed) and an absolute folder
 * (normalized), in order. Dropped: anything else, Default's id, and an id or folder an earlier entry has. A billing
 * that isn't one of PROFILE_BILLINGS is `own`. At most MAX_PROFILES.
 */
export function normalizeProfiles(raw: readonly unknown[]): ClaudeProfile[] {
  const profiles: ClaudeProfile[] = []
  for (const entry of raw) {
    if (profiles.length === MAX_PROFILES) break
    if (!isRecord(entry) || !isText(entry.id) || !isText(entry.name) || !isText(entry.configDir)) continue
    if (!entry.configDir.startsWith('/')) continue
    const { id } = entry
    const configDir = normalizeConfigDir(entry.configDir)
    if (id === DEFAULT_PROFILE_ID || profiles.some((p) => p.id === id || p.configDir === configDir)) continue
    const billing = PROFILE_BILLINGS.includes(entry.billing as ProfileBilling)
      ? (entry.billing as ProfileBilling)
      : 'own'
    profiles.push({ id, name: entry.name.trim(), configDir, billing })
  }
  return profiles
}
