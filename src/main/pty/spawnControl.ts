import { spawn } from 'node:child_process'
import type { ControlProcess } from './controlTerminal'

/**
 * Starts a control client (TmuxService.controlCommand) in `cwd`, over pipes; its stderr is dropped. Its exit is
 * reported once what it printed was read ('close'), or when it couldn't start (tmux missing): the 'error' event is
 * always handled, as an unhandled one would crash the main process.
 */
export function spawnControl(
  command: { file: string; args: string[] },
  cwd: string,
  warn: (msg: string) => void = () => {},
): ControlProcess {
  const env = { ...process.env }
  delete env.TMUX // launched from inside tmux? attaching would be refused as "nested"
  const child = spawn(command.file, command.args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  const exitCbs: (() => void)[] = []
  let exited = false
  const exit = (): void => {
    if (exited) return
    exited = true
    exitCbs.forEach((cb) => cb())
  }
  child.on('error', (err) => {
    warn(`tmux control mode: ${String(err)}`)
    exit()
  })
  child.on('close', exit)
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => child.kill(),
    on: (_event, cb) => exitCbs.push(cb),
  }
}
