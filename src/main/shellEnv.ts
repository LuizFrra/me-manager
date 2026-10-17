import { run } from './exec'

const MARK = '__ME_MANAGER_PATH__'

/**
 * GUI-launched Electron (desktop icon, macOS Dock) gets a minimal PATH that
 * misses nvm, ~/.local/bin and Homebrew. Ask the user's interactive login shell.
 */
export async function loadLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  try {
    const out = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeoutMs: 5000 })
    const match = out.match(new RegExp(`${MARK}(.*)${MARK}`))
    if (match?.[1]) process.env.PATH = match[1]
  } catch {
    // Keep the inherited PATH; the prerequisite check will report missing tools.
  }
}

const UTF8 = /utf-?8/i

/**
 * GUI-launched apps on macOS get no LANG/LC_*, so tmux (and `claude` inside it) assume
 * ASCII and print non-ASCII characters as '_'. Default to a UTF-8 locale; never override
 * a locale the user already set to UTF-8. Call before the first tmux command so the
 * tmux server inherits it.
 */
export function ensureUtf8Locale(env: NodeJS.ProcessEnv = process.env): void {
  if ([env.LC_ALL, env.LC_CTYPE, env.LANG].some((v) => v && UTF8.test(v))) return
  env.LANG = 'en_US.UTF-8'
}
