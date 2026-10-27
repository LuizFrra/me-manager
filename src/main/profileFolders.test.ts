import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProfileFolders } from './profileFolders'

describe('ProfileFolders', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mm-profiles-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** A profile folder under `root` holding `files` (name → content). */
  async function folder(name: string, files: Record<string, string> = {}): Promise<string> {
    const dir = join(root, name)
    await mkdir(dir)
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content)
    return dir
  }

  it('tells a folder that is gone, or is no folder', async () => {
    const linux = new ProfileFolders('linux')
    await expect(linux.loginState(join(root, 'gone'))).resolves.toBe('folderMissing')
    await writeFile(join(root, 'file'), '')
    await expect(linux.loginState(join(root, 'file'))).resolves.toBe('folderMissing')
  })

  it('says signed in when there is a credentials file, whatever settings.json says', async () => {
    const dir = await folder('a', { '.credentials.json': '{}', 'settings.json': '{"apiKeyHelper": "x"}' })
    await expect(new ProfileFolders('linux').loginState(dir)).resolves.toBe('signedIn')
    await expect(new ProfileFolders('darwin').loginState(dir)).resolves.toBe('signedIn')
  })

  it('says a key or gateway when settings.json has apiKeyHelper or env.ANTHROPIC_BASE_URL, whatever their value', async () => {
    const linux = new ProfileFolders('linux')
    const helper = await folder('helper', { 'settings.json': '{"apiKeyHelper": null}' })
    await expect(linux.loginState(helper)).resolves.toBe('keyOrGateway')
    const gateway = await folder('gateway', { 'settings.json': '{"env": {"ANTHROPIC_BASE_URL": ""}}' })
    await expect(new ProfileFolders('darwin').loginState(gateway)).resolves.toBe('keyOrGateway')
  })

  it('says not signed in otherwise, and unknown on macOS, where the login is in the Keychain', async () => {
    const settings = [
      '',
      'not json',
      '[]',
      '{"env": "ANTHROPIC_BASE_URL"}',
      '{"env": {"ANTHROPIC_API_KEY": "k"}}',
      '{"ANTHROPIC_BASE_URL": "u"}',
    ]
    for (const [i, content] of settings.entries()) {
      const dir = await folder(`plain-${i}`, { 'settings.json': content })
      await expect(new ProfileFolders('linux').loginState(dir)).resolves.toBe('notSignedIn')
      await expect(new ProfileFolders('darwin').loginState(dir)).resolves.toBe('unknown')
    }
    const empty = await folder('empty')
    await expect(new ProfileFolders('linux').loginState(empty)).resolves.toBe('notSignedIn')
  })

  it('creates a folder and the ones above it, private and empty, and accepts one that is there', async () => {
    const profiles = new ProfileFolders('linux')
    const dir = join(root, 'a', 'b', '.claude-work')
    await profiles.create(dir)
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    await profiles.create(dir)
    await expect(profiles.loginState(dir)).resolves.toBe('notSignedIn')
  })
})
