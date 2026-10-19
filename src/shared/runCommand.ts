/** The longest run command a repo or folder can have (see Repo.runCommand). */
export const MAX_RUN_COMMAND = 1000

/** The tmux window a run command runs in, one per task or folder session. */
export const RUN_WINDOW = 'run'

/** Control characters but tab: a line break would end the command early, a NUL can't be in one at all. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/

/**
 * Why `text` can't be a run command, or null when it can ('' and whitespace too: no command). It is one line of
 * shell, trimmed, at most MAX_RUN_COMMAND characters.
 */
export function runCommandError(text: string): string | null {
  if (typeof text !== 'string') return 'The run command must be text'
  const trimmed = text.trim()
  if (CONTROL.test(trimmed)) return 'The run command must be one line of text'
  if (trimmed.length > MAX_RUN_COMMAND)
    return `The run command is limited to ${MAX_RUN_COMMAND.toLocaleString('en-US')} characters`
  return null
}

/** A run command from the renderer (so untrusted): trimmed, '' for none. Throws runCommandError's message. */
export function normalizeRunCommand(raw: unknown): string {
  const error = runCommandError(raw as string)
  if (error) throw new Error(error)
  return (raw as string).trim()
}

/** Whether a stored value is a run command as normalizeRunCommand leaves it (not empty, already trimmed). */
export const isRunCommand = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value === value.trim() && runCommandError(value) === null
