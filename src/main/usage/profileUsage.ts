import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PROFILE_ID } from '../../shared/profiles'
import type { ClaudeProfile } from '../../shared/types'
import type { ProfileUsageApi, ProfileUsageSummaries, UsageApi, UsageSummaries } from '../contracts'

/**
 * The folder with every link resolved, or null when it isn't there. Synchronously, as UsageService stats: through
 * the thread pool it would cost several times the call itself, on every summarize.
 */
async function realpathNow(dir: string): Promise<string | null> {
  try {
    return realpathSync.native(dir)
  } catch {
    return null
  }
}

export interface ProfileUsageOptions {
  /** The current Claude profiles, Default first (see allProfiles); asked on every call, so changes follow. */
  profiles: () => readonly ClaudeProfile[]
  /** Reads every profile's folder (UsageApi.summarizeFolders). */
  usage: UsageApi
  /** The folder with every link resolved, or null when it isn't there. Default: fs.realpathSync.native. */
  realpath?: (dir: string) => Promise<string | null>
}

/**
 * Claude Code usage of every Claude profile, from one usage service reading all their folders, so that a message
 * copied into several (a folder made with `cp -r`) counts once. Folders are compared with their links resolved, so
 * a folder two profiles reach is read once.
 *
 * Default's folder is read as Default names it, as before there were profiles: the cache keeps transcripts by path.
 */
export class ProfileUsage implements ProfileUsageApi {
  private readonly profiles: () => readonly ClaudeProfile[]
  private readonly usage: UsageApi
  private readonly realpath: (dir: string) => Promise<string | null>

  constructor(options: ProfileUsageOptions) {
    this.profiles = options.profiles
    this.usage = options.usage
    this.realpath = options.realpath ?? realpathNow
  }

  async summarize(
    roots: readonly string[],
    groups: Readonly<Record<string, readonly string[]>> = {},
  ): Promise<{ usage: UsageSummaries; profiles: ProfileUsageSummaries[] }> {
    const current = await this.resolveProfiles()
    const folders = current.map(({ profile, folder }) => ({ dir: folder, billing: profile.billing }))
    const result = await this.usage.summarizeFolders(folders, roots, groups)
    return {
      usage: result.all,
      profiles: current.map(({ profile, folder }) => ({ profile, folder, usage: result.folders[folder] })),
    }
  }

  /**
   * The current profiles, each with the folder to read for it: the same for profiles whose folders resolve to the
   * same one (Default's name for its own). The profiles are asked again after resolving, until every folder is
   * resolved, so that a call started before a profile was removed doesn't read its folder.
   */
  private async resolveProfiles(): Promise<{ profile: ClaudeProfile; folder: string }[]> {
    const real = new Map<string, string>()
    let profiles = this.profiles()
    for (;;) {
      const dirs = [...new Set(profiles.map((p) => p.configDir))].filter((d) => !real.has(d))
      if (dirs.length === 0) break
      const found = await Promise.all(dirs.map((d) => this.realpath(d)))
      dirs.forEach((d, i) => real.set(d, found[i] ?? resolve(d))) // not there: nothing to read, as named
      profiles = this.profiles()
    }
    const named = new Map<string, string>()
    const defaultDir = profiles.find((p) => p.id === DEFAULT_PROFILE_ID)?.configDir
    if (defaultDir !== undefined) named.set(real.get(defaultDir)!, defaultDir)
    return profiles.map((profile) => {
      const folder = real.get(profile.configDir)!
      if (!named.has(folder)) named.set(folder, folder)
      return { profile, folder: named.get(folder)! }
    })
  }
}
