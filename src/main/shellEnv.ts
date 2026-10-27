import { run } from './exec'

const MARK = '__ME_MANAGER_PATH__'
/** How long the app waits for the login shell at startup (its window shows only after). */
export const LOGIN_SHELL_TIMEOUT_MS = 5000

/**
 * GUI-launched Electron (desktop icon, macOS Dock) gets a minimal PATH that
 * misses nvm, ~/.local/bin and Homebrew. Ask the user's interactive login shell.
 * Its input is closed, so a start-up file that asks something reads an end of file instead of waiting.
 */
export async function loadLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
): Promise<void> {
  if (process.platform === 'win32') return
  const shell = env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  try {
    const out = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeoutMs, input: '' })
    const match = out.match(new RegExp(`${MARK}(.*)${MARK}`))
    if (match?.[1]) env.PATH = match[1]
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
