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
