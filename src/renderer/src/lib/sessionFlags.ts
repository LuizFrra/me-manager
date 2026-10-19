import type { Settings } from '../../../shared/types'

/** Whether new Claude sessions really run with Remote Control on and with permission prompts skipped. */
export interface SessionFlags {
  remoteControl: boolean
  skipPermissions: boolean
}

/** The settings the flags follow from; main may also report what it works out itself, as `effective`. */
export type SessionFlagSettings = Pick<Settings, 'claudeArgs' | 'remoteControl' | 'skipPermissions'> & {
  effective?: Partial<SessionFlags>
}

/** Whether `args` set `option`, as `--option` or `--option=value` (main's rule for leaving its own flag out). */
const sets = (args: readonly string[], option: string): boolean =>
  args.some((arg) => arg === option || arg.startsWith(`${option}=`))

/** The value given to `--permission-mode`, as the next argument or after '='. */
function permissionMode(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--permission-mode') return args[i + 1]
    if (args[i].startsWith('--permission-mode=')) return args[i].slice('--permission-mode='.length)
  }
  return undefined
}

/**
 * What the header and status bar badges show. Main adds `--dangerously-skip-permissions` (or `--remote-control`)
 * only when the user's claude arguments don't already set that option: with `--permission-mode` among them, the
 * toggle alone doesn't skip anything. The arguments can also turn either on by themselves. Main's own `effective`
 * report wins when it has one.
 */
export function effectiveSessionFlags(s: SessionFlagSettings): SessionFlags {
  const args = s.claudeArgs
  const argsSkip = sets(args, '--dangerously-skip-permissions') || permissionMode(args) === 'bypassPermissions'
  return {
    remoteControl: s.effective?.remoteControl ?? (s.remoteControl || sets(args, '--remote-control')),
    skipPermissions:
      s.effective?.skipPermissions ?? (argsSkip || (s.skipPermissions && !sets(args, '--permission-mode'))),
  }
}
