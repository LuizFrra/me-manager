import { chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeProfile, ProfileBilling } from '../../shared/types'
import { emptyUsageSummary } from '../../shared/usage'
import type { UsageSummaries } from '../contracts'
import { cleanupTempDirs, makeTempDir } from '../files/testRepos'
import { usageCacheFile } from '../paths'
import { folderHash, ProfileUsage, type FolderUsage } from './profileUsage'
import { encodeProjectPath, UsageService } from './usageService'

const NOW = new Date(2026, 9, 18, 15, 0, 0)
let seq = 0

/** One assistant message in /p/proj with `input` tokens of a priced model. */
const line = (input: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(2026, 9, 18, 9).toISOString(),
    cwd: '/p/proj',
    sessionId: `s${++seq}`,
    requestId: `req_${seq}`,
    message: { id: `msg_${seq}`, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: 0 } },
  }) + '\n'

/** Writes a transcript of /p/proj into the Claude folder `dir`. */
async function put(dir: string, name: string, content: string): Promise<string> {
  const folder = join(dir, 'projects', encodeProjectPath('/p/proj'))
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name), content)
  return join(folder, name)
}

const profile = (id: string, configDir: string, billing: ProfileBilling = 'own'): ClaudeProfile => ({
  id,
  name: id,
  configDir,
  billing,
})

let home: string
let defaultDir: string
let workDir: string
let profiles: ClaudeProfile[]

beforeEach(async () => {
  home = await makeTempDir('mm-home-')
  defaultDir = await makeTempDir('mm-claude-')
  workDir = await makeTempDir('mm-claude-work-')
  profiles = [profile('default', defaultDir)]
})
afterEach(cleanupTempDirs)

/** Real UsageServices, their caches in `home`, written only when asked (saveCache). */
const usage = (): ProfileUsage =>
  new ProfileUsage({
    profiles: () => [...profiles], // a new list each time, as allProfiles gives
    cacheFile: (hash) => usageCacheFile(hash, home),
    service: { now: () => NOW, minRefreshMs: 0, cacheSaveDelayMs: 3_600_000 },
  })

/** A stand-in for a folder's service, recording what happens to it. */
class FakeFolder implements FolderUsage {
  saved = 0
  constructor(
    readonly claudeDir: string,
    readonly cacheFile: string,
  ) {}
  get projectsDir(): string {
    return join(this.claudeDir, 'projects')
  }
  async summarize(): Promise<UsageSummaries> {
    return { roots: { '/p/proj': emptyUsageSummary() }, groups: {} }
  }
  async saveCache(): Promise<void> {
    this.saved++
  }
}

/** ProfileUsage over FakeFolders; `made` lists every one made, in order. */
function withFakes(realpath?: (dir: string) => Promise<string | null>): { usage: ProfileUsage; made: FakeFolder[] } {
  const made: FakeFolder[] = []
  const u = new ProfileUsage({
    profiles: () => [...profiles], // a new list each time, as allProfiles gives
    cacheFile: (hash) => usageCacheFile(hash, home),
    realpath,
    createService: (claudeDir, cacheFile) => {
      const f = new FakeFolder(claudeDir, cacheFile)
      made.push(f)
      return f
    },
  })
  return { usage: u, made }
}

describe('ProfileUsage', () => {
  it('reads every profile’s folder for the same roots, Default first, each with its own usage', async () => {
    await put(defaultDir, 'a.jsonl', line(10))
    await put(workDir, 'b.jsonl', line(20) + line(30))
    profiles.push(profile('work', workDir, 'company'))
    const result = await usage().summarize(['/p/proj'], { total: ['/p/proj'] })
    expect(
      result.map((r) => [r.profile.id, r.usage.roots['/p/proj'].all.input, r.usage.groups.total.all.messages]),
    ).toEqual([
      ['default', 10, 1],
      ['work', 50, 2],
    ])
    // As read: billing is applied when merging (see mergeProfileUsage).
    expect(result[1].usage.roots['/p/proj'].all.cost).toBeGreaterThan(0)
    expect(result.map((r) => r.folder)).toEqual([defaultDir, workDir])
  })

  it('reads a folder reached through two profiles once', async () => {
    await put(defaultDir, 'a.jsonl', line(10))
    const link = join(home, 'link-to-default')
    await symlink(defaultDir, link)
    profiles.push(profile('alias', link))
    const { usage: fakes, made } = withFakes()
    const result = await fakes.summarize(['/p/proj'])
    expect(made).toHaveLength(1)
    expect(result.map((r) => r.folder)).toEqual([defaultDir, defaultDir])
    expect(result[1].usage).toBe(result[0].usage)

    const real = await usage().summarize(['/p/proj'])
    expect(real[1].usage).toBe(real[0].usage)
    expect(real[0].usage.roots['/p/proj'].all.input).toBe(10)
  })

  it('adds a service for a profile added while it runs, and drops (after saving) one no profile uses any more', async () => {
    const { usage: u, made } = withFakes()
    await u.summarize(['/p/proj'])
    expect(made.map((f) => f.claudeDir)).toEqual([defaultDir])

    profiles.push(profile('work', workDir))
    expect((await u.summarize(['/p/proj'])).map((r) => r.profile.id)).toEqual(['default', 'work'])
    expect(made.map((f) => f.claudeDir)).toEqual([defaultDir, workDir])

    profiles.pop()
    expect((await u.summarize(['/p/proj'])).map((r) => r.profile.id)).toEqual(['default'])
    expect(made[1].saved).toBe(1)
    await u.saveCache()
    expect(made.map((f) => f.saved)).toEqual([1, 1]) // the dropped one is not saved again

    profiles.push(profile('work', workDir)) // back: a new service, which reads its cache file
    await u.summarize(['/p/proj'])
    expect(made.map((f) => f.claudeDir)).toEqual([defaultDir, workDir, workDir])
  })

  it('does not bring back the service of a profile removed while a call was resolving its folder', async () => {
    profiles.push(profile('work', workDir))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    const { usage: u, made } = withFakes(async (dir) => {
      if (first) {
        first = false
        await gate
      }
      return dir
    })
    const slow = u.summarize(['/p/proj'])
    profiles.pop()
    expect((await u.summarize(['/p/proj'])).map((r) => r.profile.id)).toEqual(['default'])
    release()
    expect((await slow).map((r) => r.profile.id)).toEqual(['default'])
    expect(made.map((f) => f.claudeDir)).toEqual([defaultDir])
  })

  it('keeps the Default folder’s cache in usage-cache.json, as before, and each other folder’s in its own', async () => {
    const transcript = await put(defaultDir, 'a.jsonl', line(10))
    // A cache written before profiles existed, by the one usage service there was.
    const before = new UsageService({ claudeDir: defaultDir, cacheFile: usageCacheFile(undefined, home) })
    await before.summarize(['/p/proj'])
    await before.saveCache()
    // Unreadable now: only the cache can still count it (it is unchanged, so it is not read again).
    await chmod(transcript, 0)
    await put(workDir, 'b.jsonl', line(20))
    profiles.push(profile('work', workDir))

    const u = usage()
    const result = await u.summarize(['/p/proj'])
    expect(result.map((r) => r.usage.roots['/p/proj'].all.input)).toEqual([10, 20])
    await u.saveCache()
    expect((await readdir(home)).sort()).toEqual(['usage-cache-' + folderHash(workDir) + '.json', 'usage-cache.json'])
    const work = JSON.parse(await readFile(usageCacheFile(folderHash(workDir), home), 'utf8'))
    expect(work.dir).toBe(join(workDir, 'projects'))
    expect(folderHash(workDir)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reads nothing for a profile whose folder is not there', async () => {
    profiles.push(profile('gone', join(home, 'missing')))
    const result = await usage().summarize(['/p/proj'])
    expect(result.map((r) => [r.profile.id, r.folder, r.usage.roots['/p/proj'].all.messages])).toEqual([
      ['default', defaultDir, 0],
      ['gone', join(home, 'missing'), 0],
    ])
  })
})
