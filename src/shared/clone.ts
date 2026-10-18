/**
 * Checks for "Clone repository…", shared by the dialog (to explain a problem as it is typed) and main (which never
 * trusts the renderer). They refuse what looks like an option (`-u…`, `--upload-pack=…`) or names a
 * command-running transport (`ext::sh -c …`); main also passes the URL after `--` and turns the ext and fd
 * transports off, so no single check is the only lock. They only judge the URL's form: they don't make the
 * server, or what the user's own git and ssh config do with it, trustworthy.
 */

export const MAX_CLONE_URL = 2048
/**
 * Longest folder name a clone gets, in characters (UTF-16 code units). Most filesystems allow 255 bytes, which
 * 200 characters of ASCII stay under; a long name in other scripts can still be too long for the disk, and then
 * the clone fails with the filesystem's error.
 */
export const MAX_CLONE_NAME = 200

/** Schemes accepted in `<scheme>://` URLs. Anything else (`ext::`, `fd::`, `http://`, `git://`) is refused. */
export const CLONE_SCHEMES = ['https', 'ssh', 'file'] as const

/** `user@host:path`, the scp-like ssh form git accepts (e.g. `git@github.com:owner/repo.git`). */
const SCP_LIKE = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/
const URL_LIKE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//

/** Why `url` can't be cloned, or null when it can. */
export function cloneUrlError(raw: string): string | null {
  if (typeof raw !== 'string') return 'Enter a repository URL'
  const url = raw.trim()
  if (!url) return 'Enter a repository URL'
  if (url.length > MAX_CLONE_URL) return `The URL is limited to ${MAX_CLONE_URL} characters`
  if (url.startsWith('-')) return 'A URL can’t start with “-”'
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return 'A URL can’t contain spaces or control characters'
  // `<transport>::<address>` runs a remote helper; `ext::` runs any command.
  if (/^[A-Za-z0-9+.-]+::/.test(url)) return 'Transports like ext:: and fd:: aren’t allowed'

  const scheme = URL_LIKE.exec(url)?.[1]?.toLowerCase()
  if (scheme === undefined) {
    const scp = SCP_LIKE.exec(url)
    if (!scp) return 'Use an https://, ssh://, file:// or git@host:path URL'
    if (scp[3].startsWith('-')) return 'The repository path can’t start with “-”'
    return null
  }
  if (!(CLONE_SCHEMES as readonly string[]).includes(scheme)) {
    return `${scheme}:// URLs aren’t supported; use https://, ssh://, file:// or git@host:path`
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'This URL is not valid'
  }
  if (scheme === 'file') {
    if (parsed.host && parsed.host !== 'localhost') return 'A file:// URL must point to a local path'
    if (!parsed.pathname || parsed.pathname === '/') return 'The URL has no repository path'
    return null
  }
  // A host starting with '-' would reach ssh as an option.
  if (!parsed.hostname || parsed.hostname.startsWith('-')) return 'The URL has no valid host'
  if (!parsed.pathname || parsed.pathname === '/') return 'The URL has no repository path'
  return null
}

/** The URL, trimmed; throws with cloneUrlError's message when it can't be cloned. */
export function checkCloneUrl(url: unknown): string {
  const error = typeof url === 'string' ? cloneUrlError(url) : 'Enter a repository URL'
  if (error) throw new Error(error)
  return (url as string).trim()
}

/** The folder a clone of `url` gets by default, like git's own choice: the last path part, without `.git`. */
export function cloneNameFromUrl(raw: string): string {
  let path = raw.trim()
  const scheme = URL_LIKE.exec(path)
  if (scheme) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      path = path.slice(scheme[0].length)
    }
  } else {
    const scp = SCP_LIKE.exec(path)
    if (scp) path = scp[3]
  }
  const last =
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\:]/)
      .pop() ?? ''
  const name = last.replace(/\.git$/i, '').replace(/\.bundle$/i, '')
  return cloneNameError(name) ? '' : name
}

/**
 * Why `name` (trimmed) can't be the clone's folder name, or null. Whether it already exists is checked by main;
 * names a filesystem refuses for other reasons (too many bytes, reserved names) fail when the clone runs.
 */
export function cloneNameError(raw: string): string | null {
  if (typeof raw !== 'string') return 'Enter a folder name'
  const name = raw.trim()
  if (!name) return 'Enter a folder name'
  if (name.length > MAX_CLONE_NAME) return `The folder name is limited to ${MAX_CLONE_NAME} characters`
  if (name.includes('/') || name.includes('\\')) return 'The folder name can’t contain “/”'
  if (name === '.' || name === '..') return 'Choose another folder name'
  // A folder named .git would pass for the parent folder's own git repository.
  if (name.toLowerCase() === '.git') return 'The folder name can’t be “.git”'
  // Windows (and so an SMB or NTFS drive) drops trailing dots and spaces, so the name would change.
  if (/[. ]$/.test(name)) return 'The folder name can’t end with “.” or a space'
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'The folder name can’t contain control characters'
  return null
}

/** The name, trimmed; throws with cloneNameError's message when it can't be used. */
export function checkCloneName(name: unknown): string {
  const error = typeof name === 'string' ? cloneNameError(name) : 'Enter a folder name'
  if (error) throw new Error(error)
  return (name as string).trim()
}
