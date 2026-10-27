import { constants } from 'node:fs'
import { access, mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProfileLogin } from '../shared/types'
import type { ProfileFoldersApi } from './contracts'

/** The largest settings.json read; a bigger one counts as none. */
export const MAX_SETTINGS_BYTES = 1024 * 1024

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
    const text = await readSettings(join(dir, 'settings.json'))
    const settings: unknown = text === null ? null : JSON.parse(text)
    if (!isRecord(settings)) return false
    return 'apiKeyHelper' in settings || (isRecord(settings.env) && 'ANTHROPIC_BASE_URL' in settings.env)
  } catch {
    return false
  }
}

/**
 * The file's text when it is a regular file of at most MAX_SETTINGS_BYTES, else null. Opened without blocking
 * and checked through what was opened, so a FIFO put there (even after a check) can't make the read wait forever.
 */
async function readSettings(path: string): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return null
    return await file.readFile('utf8')
  } finally {
    await file.close()
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
