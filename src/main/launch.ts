import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { commandBasename, isTerminalEditor } from '../shared/editor'
import { splitShellWords } from '../shared/shell'
import type { LauncherApi } from './contracts'

export const NO_EDITOR_FOUND = 'No editor found — set one in Settings'
export const MAC_VSCODE_APP = 'Visual Studio Code'

/** What the launcher needs from the system; injected so tests can fake it. */
export interface LaunchDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homedir: string
  /** The executable's full path, if `cmd` is on PATH. */
  which(cmd: string): string | null
  exists(path: string): boolean
  /** Starts file/args detached, without a shell; resolves once it started, rejects if it couldn't. */
  spawn(file: string, args: string[], cwd: string): Promise<void>
  /** Electron's shell.openPath: '' on success, else an error message. */
  openPath(path: string): Promise<string>
}

export interface EditorLaunch {
  file: string
  args: string[]
}

/** Whether the command's program exists: a path is checked as is, a bare name looked up on PATH. */
function resolvable(file: string, deps: LaunchDeps): boolean {
  if (file.includes('/')) return isAbsolute(file) && deps.exists(file)
  return deps.which(file) !== null
}

/** A command line from $VISUAL / $EDITOR, or null when unusable (unparsable, empty, terminal-only, missing). */
function fromEnv(value: string | undefined, deps: LaunchDeps): string[] | null {
  if (!value?.trim()) return null
  let argv: string[]
  try {
    argv = splitShellWords(value)
  } catch {
    return null
  }
  if (argv.length === 0 || isTerminalEditor(argv) || !resolvable(argv[0], deps)) return null
  return argv
}

function macVsCodeApp(deps: LaunchDeps): boolean {
  if (deps.platform !== 'darwin') return false
  const bundle = `${MAC_VSCODE_APP}.app`
  return deps.exists(join('/Applications', bundle)) || deps.exists(join(deps.homedir, 'Applications', bundle))
}

/**
 * The argv that opens `path` in an editor. Never a shell: the command line is split into words here and the
 * path is one more argument.
 *
 * With `editorCommand` (Settings), that command is used, with the path appended; a terminal editor is refused,
 * since it would start with no terminal and never show up.
 *
 * Otherwise the first available of:
 * 1. `code` on PATH;
 * 2. on macOS, `open -a "Visual Studio Code"` when the app is installed but its `code` shim isn't on PATH;
 * 3. `cursor` on PATH;
 * 4. $VISUAL, then $EDITOR, when they name a GUI editor (see isTerminalEditor) that exists.
 */
export function editorLaunch(path: string, editorCommand: string, deps: LaunchDeps): EditorLaunch {
  if (editorCommand.trim()) {
    let argv: string[]
    try {
      argv = splitShellWords(editorCommand)
    } catch (err) {
      throw new Error(`The editor command in Settings is invalid: ${(err as Error).message}`, { cause: err })
    }
    if (argv.length > 0) {
      const name = commandBasename(argv[0])
      if (isTerminalEditor(argv))
        throw new Error(`${name} runs in a terminal, so it can't be opened from here — set a GUI editor in Settings`)
      if (!resolvable(argv[0], deps)) throw new Error(`Editor not found: ${argv[0]} — check the command in Settings`)
      return { file: argv[0], args: [...argv.slice(1), path] }
    }
  }
  if (deps.which('code')) return { file: 'code', args: [path] }
  if (macVsCodeApp(deps)) return { file: 'open', args: ['-a', MAC_VSCODE_APP, path] }
  if (deps.which('cursor')) return { file: 'cursor', args: [path] }
  const argv = fromEnv(deps.env.VISUAL, deps) ?? fromEnv(deps.env.EDITOR, deps)
  if (argv) return { file: argv[0], args: [...argv.slice(1), path] }
  throw new Error(NO_EDITOR_FOUND)
}

export function createLauncher(deps: LaunchDeps): LauncherApi {
  return {
    async openInEditor(path, editorCommand) {
      const { file, args } = editorLaunch(path, editorCommand, deps)
      try {
        await deps.spawn(file, args, path)
      } catch (err) {
        throw new Error(`Could not start ${commandBasename(file)}: ${(err as Error).message}`, { cause: err })
      }
    },
    async openInFileManager(path) {
      const error = await deps.openPath(path)
      if (error) throw new Error(`Could not open the file manager: ${error}`)
    },
  }
}

/** `which`, without a shell: the first executable file named `cmd` in PATH. */
export function whichOnPath(cmd: string, pathVar = process.env.PATH ?? ''): string | null {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, cmd)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/** Spawns detached with stdio ignored and no shell, so the editor outlives the app and gets no input from it. */
export function spawnDetached(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** The real system, for the app; `openPath` is Electron's shell.openPath (kept out so tests needn't load Electron). */
export function systemLaunchDeps(openPath: (path: string) => Promise<string>): LaunchDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: homedir(),
    which: (cmd) => whichOnPath(cmd, process.env.PATH),
    exists: existsSync,
    spawn: spawnDetached,
    openPath,
  }
}
