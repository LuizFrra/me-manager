import { chmod, cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeProfile, ProfileBilling } from '../../shared/types'
import { emptyUsageSummary } from '../../shared/usage'
import type { FolderUsageSummaries, UsageApi, UsageFolderSpec, UsageSummaries } from '../contracts'
import { cleanupTempDirs, makeTempDir } from '../files/testRepos'
import { ProfileUsage } from './profileUsage'
import { encodeProjectPath, UsageService } from './usageService'

const NOW = new Date(2026, 9, 18, 15, 0, 0)
let seq = 0

/** One assistant message in /p/proj with `input` tokens of a priced model, in a session of its own. */
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

/** The usage service, its cache in `home`, written only when asked (saveCache). */
const service = (): UsageService =>
  new UsageService({
    claudeDir: defaultDir,
    cacheFile: join(home, 'usage-cache.json'),
    now: () => NOW,
    minRefreshMs: 0,
    cacheSaveDelayMs: 3_600_000,
  })

/** ProfileUsage over `usage`, with the profiles as a new list each time (as allProfiles gives them). */
const over = (usage: UsageApi, realpath?: (dir: string) => Promise<string | null>): ProfileUsage =>
  new ProfileUsage({ profiles: () => [...profiles], usage, realpath })

const inputOf = (u: UsageSummaries): number => u.roots['/p/proj'].all.input

/** A usage service that records the folders it is asked for and reads nothing. */
class FoldersSeen implements UsageApi {
  projectsDir = ''
  calls: UsageFolderSpec[][] = []
  async summarize(): Promise<UsageSummaries> {
    throw new Error('not used')
  }
  async summarizeFolders(folders: readonly UsageFolderSpec[]): Promise<FolderUsageSummaries> {
    this.calls.push([...folders])
    const empty = { roots: { '/p/proj': emptyUsageSummary() }, groups: {} }
    return { all: empty, folders: Object.fromEntries(folders.map((f) => [f.dir, empty])) }
  }
}

describe('ProfileUsage', () => {
  it('reads every profile’s folder: all of them together, and each profile’s, Default first', async () => {
    await put(defaultDir, 'a.jsonl', line(10))
    await put(workDir, 'b.jsonl', line(20) + line(30))
    profiles.push(profile('work', workDir, 'company'))
    const { usage, profiles: each } = await over(service()).summarize(['/p/proj'], { total: ['/p/proj'] })
    expect(usage.roots['/p/proj'].all).toMatchObject({ input: 60, messages: 3, companyTokens: 50 })
    expect(usage.groups.total.all.input).toBe(60)
    expect(each.map((p) => [p.profile.id, p.folder, inputOf(p.usage), p.usage.roots['/p/proj'].all.cost > 0])).toEqual([
      ['default', defaultDir, 10, true],
      ['work', workDir, 50, false],
    ])
  })

  it('counts the messages of a folder copied from another once', async () => {
    await put(defaultDir, 'a.jsonl', line(10))
    await cp(defaultDir, workDir, { recursive: true }) // cp -r ~/.claude ~/.claude-work
    await put(workDir, 'b.jsonl', line(5))
    for (const billing of ['company', 'own'] as const) {
      profiles = [profile('default', defaultDir), profile('work', workDir, billing)]
      const { usage, profiles: each } = await over(service()).summarize(['/p/proj'])
      expect(usage.roots['/p/proj'].all).toMatchObject({ input: 15, messages: 2 })
      const messages = each.map((p) => p.usage.roots['/p/proj'].all.messages)
      // Billed to a company, the copy counts as Default's; both own-billed, as either's.
      if (billing === 'company') expect(messages).toEqual([1, 1])
      else expect(messages[0] + messages[1]).toBe(2)
    }
  })

  it('reads a folder reached through two profiles once', async () => {
    await put(defaultDir, 'a.jsonl', line(10))
    const link = join(home, 'link-to-default')
    await symlink(defaultDir, link)
    profiles.push(profile('alias', link, 'company'))
    const seen = new FoldersSeen()
    await over(seen).summarize(['/p/proj'])
    expect(seen.calls).toEqual([
      [
        { dir: defaultDir, billing: 'own' },
        { dir: defaultDir, billing: 'company' },
      ],
    ])

    const { usage, profiles: each } = await over(service()).summarize(['/p/proj'])
    expect(each.map((p) => p.folder)).toEqual([defaultDir, defaultDir])
    expect(each[1].usage).toBe(each[0].usage)
    expect(usage.roots['/p/proj'].all).toMatchObject({ input: 10, messages: 1, companyTokens: 0 })
  })

  it('reads Default’s folder as Default names it, so a cache from before profiles is still used', async () => {
    const real = await makeTempDir('mm-claude-real-')
    const transcript = await put(real, 'a.jsonl', line(10))
    defaultDir = join(home, 'claude-link') // ~/.claude as a link
    await symlink(real, defaultDir)
    profiles = [profile('default', defaultDir), profile('other', real)] // a link made after it was added
    // A cache written by the one usage service there was, of ~/.claude.
    const before = service()
    await before.summarize(['/p/proj'])
    await before.saveCache()
    // Unreadable now: only the cache can still count it (it is unchanged, so it is not read again).
    await chmod(transcript, 0)

    const { usage, profiles: each } = await over(service()).summarize(['/p/proj'])
    expect(each.map((p) => p.folder)).toEqual([defaultDir, defaultDir])
    expect(inputOf(usage)).toBe(10)
  })

  it('follows profiles added and removed while it runs', async () => {
    await put(defaultDir, 'a.jsonl', line(10))
    await put(workDir, 'b.jsonl', line(20))
    const u = over(service())
    expect(inputOf((await u.summarize(['/p/proj'])).usage)).toBe(10)
    profiles.push(profile('work', workDir))
    expect(inputOf((await u.summarize(['/p/proj'])).usage)).toBe(30)
    profiles.pop()
    const after = await u.summarize(['/p/proj'])
    expect(after.profiles.map((p) => p.profile.id)).toEqual(['default'])
    expect(inputOf(after.usage)).toBe(10)
  })

  it('does not read the folder of a profile removed while a call was resolving its folder', async () => {
    profiles.push(profile('work', workDir))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    const seen = new FoldersSeen()
    const u = over(seen, async (dir) => {
      if (first) {
        first = false
        await gate
      }
      return dir
    })
    const slow = u.summarize(['/p/proj'])
    profiles.pop()
    release()
    expect((await slow).profiles.map((p) => p.profile.id)).toEqual(['default'])
    expect(seen.calls).toEqual([[{ dir: defaultDir, billing: 'own' }]])
  })

  it('reads nothing for a profile whose folder is not there', async () => {
    profiles.push(profile('gone', join(home, 'missing')))
    const { profiles: each } = await over(service()).summarize(['/p/proj'])
    expect(each.map((p) => [p.profile.id, p.folder, p.usage.roots['/p/proj'].all.messages])).toEqual([
      ['default', defaultDir, 0],
      ['gone', join(home, 'missing'), 0],
    ])
  })
})
