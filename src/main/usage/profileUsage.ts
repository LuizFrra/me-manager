import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PROFILE_ID } from '../../shared/profiles'
import type { ClaudeProfile } from '../../shared/types'
import type { ProfileUsageApi, ProfileUsageSummaries, UsageApi, UsageSummaries } from '../contracts'
import { usageCacheFile } from '../paths'
import { UsageService, type UsageServiceOptions } from './usageService'

/** What ProfileUsage needs of one folder's usage service. */
export type FolderUsage = UsageApi & Pick<UsageService, 'saveCache'>

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

/** Names a folder's cache file (see usageCacheFile): the start of its path's SHA-256, in hex. */
export const folderHash = (folder: string): string => createHash('sha256').update(folder).digest('hex').slice(0, 16)

export interface ProfileUsageOptions {
  /** The current Claude profiles, Default first (see allProfiles); asked on every call, so changes follow. */
  profiles: () => readonly ClaudeProfile[]
  /** Where a folder's cache is kept, by its folderHash (none for Default's). Default: usageCacheFile. */
  cacheFile?: (folderHash?: string) => string
  /** The folder with every link resolved, or null when it isn't there. Default: fs.realpathSync.native. */
  realpath?: (dir: string) => Promise<string | null>
  /** Makes the service of one folder. Default: a UsageService with `service` as its other options. */
  createService?: (claudeDir: string, cacheFile: string) => FolderUsage
  service?: Omit<UsageServiceOptions, 'claudeDir' | 'cacheFile'>
}

interface Folder {
  /** The folder the service reads: Default's as Default names it, any other with its links resolved. */
  claudeDir: string
  cacheFile: string
  service: FolderUsage
}

/**
 * Claude Code usage of every Claude profile: one UsageService per folder, by the folder with its links resolved, so
 * that two profiles on one folder share one reading of it. Services follow the profiles: one is made for a folder
 * the first time a profile has it, and dropped (its cache written) once none has.
 *
 * Default's folder keeps the cache file it had before there were profiles, and is read as Default names it, so
 * that cache (which names the folder it was read from) is still used.
 */
export class ProfileUsage implements ProfileUsageApi {
  private readonly profiles: () => readonly ClaudeProfile[]
  private readonly cacheFile: (folderHash?: string) => string
  private readonly realpath: (dir: string) => Promise<string | null>
  private readonly createService: (claudeDir: string, cacheFile: string) => FolderUsage
  /** By the folder with its links resolved. */
  private folders = new Map<string, Folder>()
  /** Caches of dropped services still being written, waited for by saveCache. */
  private saving = new Set<Promise<void>>()

  constructor(options: ProfileUsageOptions) {
    this.profiles = options.profiles
    this.cacheFile = options.cacheFile ?? usageCacheFile
    this.realpath = options.realpath ?? realpathNow
    this.createService =
      options.createService ??
      ((claudeDir, cacheFile) => new UsageService({ ...options.service, claudeDir, cacheFile }))
  }

  async summarize(
    roots: readonly string[],
    groups: Readonly<Record<string, readonly string[]>> = {},
  ): Promise<ProfileUsageSummaries[]> {
    const current = await this.resolveProfiles()
    const services = [...new Map(current.map((c) => [c.folder, c.service]))]
    const results = await Promise.all(services.map(([, service]) => service.summarize(roots, groups)))
    const usage = new Map<string, UsageSummaries>(services.map(([folder], i) => [folder, results[i]]))
    return current.map(({ profile, folder }) => ({ profile, folder, usage: usage.get(folder)! }))
  }

  /** Writes every folder's cache now (see UsageService.saveCache), and waits for those of dropped folders. */
  async saveCache(): Promise<void> {
    await Promise.all([...[...this.folders.values()].map((f) => f.service.saveCache()), ...this.saving])
  }

  /**
   * The current profiles, each with its folder (links resolved) and that folder's service, the services brought in
   * line with them. The profiles are asked again after resolving, until every folder is resolved, so that a call
   * started before a profile was removed doesn't bring its service back.
   */
  private async resolveProfiles(): Promise<{ profile: ClaudeProfile; folder: string; service: FolderUsage }[]> {
    const real = new Map<string, string>()
    let profiles = this.profiles()
    for (;;) {
      const dirs = [...new Set(profiles.map((p) => p.configDir))].filter((d) => !real.has(d))
      if (dirs.length === 0) break
      const found = await Promise.all(dirs.map((d) => this.realpath(d)))
      dirs.forEach((d, i) => real.set(d, found[i] ?? resolve(d))) // not there: nothing to read, as named
      profiles = this.profiles()
    }
    const defaultDir = profiles.find((p) => p.id === DEFAULT_PROFILE_ID)?.configDir
    const defaultFolder = defaultDir === undefined ? undefined : real.get(defaultDir)
    const wanted = new Map<string, Omit<Folder, 'service'>>()
    for (const p of profiles) {
      const folder = real.get(p.configDir)!
      if (wanted.has(folder)) continue
      wanted.set(
        folder,
        folder === defaultFolder
          ? { claudeDir: defaultDir!, cacheFile: this.cacheFile() }
          : { claudeDir: folder, cacheFile: this.cacheFile(folderHash(folder)) },
      )
    }
    for (const [folder, f] of this.folders) {
      const want = wanted.get(folder)
      if (want?.claudeDir === f.claudeDir && want.cacheFile === f.cacheFile) continue
      this.folders.delete(folder)
      // What it read since its last write is kept, for when a profile has the folder again.
      const saved = f.service.saveCache().finally(() => this.saving.delete(saved))
      this.saving.add(saved)
    }
    for (const [folder, want] of wanted) {
      if (!this.folders.has(folder))
        this.folders.set(folder, { ...want, service: this.createService(want.claudeDir, want.cacheFile) })
    }
    return profiles.map((profile) => {
      const folder = real.get(profile.configDir)!
      return { profile, folder, service: this.folders.get(folder)!.service }
    })
  }
}
