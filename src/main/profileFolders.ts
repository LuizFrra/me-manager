import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProfileLogin } from '../shared/types'
import type { ProfileFoldersApi } from './contracts'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/**
 * Whether the folder's settings.json sends Claude through a key or a gateway: it has an `apiKeyHelper` or an
 * `env.ANTHROPIC_BASE_URL`. Only that the keys are there is looked at, never their values, which are not kept.
 */
async function usesKeyOrGateway(dir: string): Promise<boolean> {
  try {
    const settings: unknown = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    if (!isRecord(settings)) return false
    return 'apiKeyHelper' in settings || (isRecord(settings.env) && 'ANTHROPIC_BASE_URL' in settings.env)
  } catch {
    return false
  }
}

/** Claude profile folders on disk (see ProfileFoldersApi). */
export class ProfileFolders implements ProfileFoldersApi {
  /** `platform`: process.platform, for tests. */
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async loginState(dir: string): Promise<ProfileLogin> {
    const isDir = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    )
    if (!isDir) return 'folderMissing'
    if (await exists(join(dir, '.credentials.json'))) return 'signedIn'
    if (await usesKeyOrGateway(dir)) return 'keyOrGateway'
    // Claude Code keeps a macOS login in the Keychain, not in the folder.
    return this.platform === 'darwin' ? 'unknown' : 'notSignedIn'
  }

  async create(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }
}
