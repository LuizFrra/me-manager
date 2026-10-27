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

/**
 * A profile's folder as typed or loaded, trimmed and normalized, or why it can't be one: it must be absolute text,
 * not the root, without `.` or `..` segments (two spellings of one folder would pass for two), and not end in `;`
 * (as CLAUDE_CONFIG_DIR, it would end the tmux command it is passed in).
 */
function checkFolder(dir: unknown): { folder: string } | { error: string } {
  if (!isText(dir) || !dir.trim().startsWith('/')) return { error: 'Choose an absolute folder (starting with /)' }
  const folder = normalizeConfigDir(dir.trim())
  if (folder === '/') return { error: 'Choose a folder other than /' }
  if (folder.split('/').some((segment) => segment === '.' || segment === '..'))
    return { error: 'Choose a folder without . or .. in its path' }
  if (folder.endsWith(';')) return { error: 'A folder can’t end in ;' }
  return { folder }
}

/** checkFolder's folder, or null. */
const profileFolder = (dir: unknown): string | null => {
  const checked = checkFolder(dir)
  return 'folder' in checked ? checked.folder : null
}

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
 * profile, a hand edit, a theme restored after its profile was removed) is skipped at each level, so a task's
 * unknown profile gives its theme's, with `fellBack` set so the caller can say so.
 */
export function effectiveProfileId(
  profiles: readonly ClaudeProfile[],
  theme: { profileId?: string },
  task?: { profileId?: string },
): { id: string; fellBack: boolean } {
  let fellBack = false
  for (const id of [task?.profileId, theme.profileId]) {
    if (id === undefined) continue
    if (profiles.some((p) => p.id === id)) return { id, fellBack }
    fellBack = true
  }
  return { id: DEFAULT_PROFILE_ID, fellBack }
}

/**
 * Why a new or edited profile is refused, or null: an empty name, a name another profile (`others`, Default
 * included and the edited one left out) has, ignoring case and surrounding spaces, a folder checkFolder refuses, or
 * one another profile already uses, once trimmed and normalized. The same checks as normalizeProfiles, so what is
 * accepted here is kept when saved.
 */
export function profileError(
  p: Pick<ClaudeProfile, 'name' | 'configDir'>,
  others: readonly ClaudeProfile[],
): string | null {
  if (!isText(p.name)) return 'Enter a name'
  const name = p.name.trim().toLowerCase()
  const namesake = others.find((o) => o.name.trim().toLowerCase() === name)
  if (namesake) return `Another account is named “${namesake.name}”`
  const checked = checkFolder(p.configDir)
  if ('error' in checked) return checked.error
  const dir = checked.folder
  const owner = others.find((o) => normalizeConfigDir(o.configDir) === dir)
  return owner ? `“${owner.name}” already uses this folder` : null
}

/**
 * Settings.profiles from untrusted input: entries with an id and a name (trimmed) and a folder checkFolder accepts
 * (trimmed and normalized), in order. Dropped: anything else, Default's id, an id or folder an earlier entry has,
 * and Default's folder (`defaultDir`, when known). A billing that isn't one of PROFILE_BILLINGS is `own`. At most
 * MAX_PROFILES.
 */
export function normalizeProfiles(raw: readonly unknown[], defaultDir?: string): ClaudeProfile[] {
  const defaultFolder = defaultDir === undefined ? null : normalizeConfigDir(defaultDir.trim())
  const profiles: ClaudeProfile[] = []
  for (const entry of raw) {
    if (profiles.length === MAX_PROFILES) break
    if (!isRecord(entry) || !isText(entry.id) || !isText(entry.name)) continue
    const { id } = entry
    const configDir = profileFolder(entry.configDir)
    if (
      configDir === null ||
      configDir === defaultFolder ||
      id === DEFAULT_PROFILE_ID ||
      profiles.some((p) => p.id === id || p.configDir === configDir)
    )
      continue
    const billing = PROFILE_BILLINGS.includes(entry.billing as ProfileBilling)
      ? (entry.billing as ProfileBilling)
      : 'own'
    profiles.push({ id, name: entry.name.trim(), configDir, billing })
  }
  return profiles
}
