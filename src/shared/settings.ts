import { BUDGET_LIMITS } from './budget'
import { normalizeTaskTemplates } from './templates'
import { UPDATE_STRATEGIES, type EffectiveClaudeFlags, type Settings, type UpdateStrategy } from './types'

export const POLL_INTERVAL_LIMITS = { min: 1000, max: 30_000 } as const
export const FONT_SIZE_LIMITS = { min: 8, max: 32 } as const

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  claudeArgs: [],
  editorCommand: '',
  pollIntervalMs: 3000,
  terminalFontSize: 13,
  notifications: true,
  remoteControl: true,
  skipPermissions: true,
  updateStrategy: 'rebase',
  cloneDirectory: '',
  showStatusBar: true,
  taskTemplates: [],
  dailyBudgetUsd: null,
  taskBudgetUsd: null,
})

type ClaudeFlagSettings = Pick<Settings, 'claudeArgs' | 'remoteControl' | 'skipPermissions'>

/** Whether `args` set one of `options`, as `--opt value` or `--opt=value`. */
const setsOption = (args: readonly string[], ...options: string[]): boolean =>
  args.some((arg) => options.some((o) => arg === o || arg.startsWith(`${o}=`)))

/**
 * The flags the app puts before the user's arguments when it starts Claude in a session labelled `label`
 * (`<theme>/<repo>/<task>` or `<theme>/<folder>`): Remote Control and skipped permissions, when enabled. A flag
 * is left out when the user's arguments already set that option.
 */
export function builtInClaudeFlags(settings: ClaudeFlagSettings, label: string): string[] {
  const { claudeArgs, remoteControl, skipPermissions } = settings
  const flags: string[] = []
  if (remoteControl && !setsOption(claudeArgs, '--remote-control')) flags.push('--remote-control', label)
  if (skipPermissions && !setsOption(claudeArgs, '--dangerously-skip-permissions', '--permission-mode')) {
    flags.push('--dangerously-skip-permissions')
  }
  return flags
}

/** What applies to a session's command (builtInClaudeFlags, then the user's arguments): see EffectiveClaudeFlags. */
export function effectiveClaudeFlags(settings: ClaudeFlagSettings): EffectiveClaudeFlags {
  const args = [...builtInClaudeFlags(settings, 'label'), ...settings.claudeArgs]
  const bypassMode = args.some(
    (arg, i) =>
      arg === '--permission-mode=bypassPermissions' ||
      (arg === '--permission-mode' && args[i + 1] === 'bypassPermissions'),
  )
  return {
    remoteControl: setsOption(args, '--remote-control'),
    skipPermissions: setsOption(args, '--dangerously-skip-permissions') || bypassMode,
  }
}

export const clamp = (n: number, { min, max }: { min: number; max: number }): number => Math.min(max, Math.max(min, n))

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A NUL can't be part of a command-line argument. */
const isArgString = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Turns anything (a parsed settings.json, a renderer's patch merged over the current settings) into valid
 * Settings. Known keys only; unknown ones are dropped. A missing or wrongly typed value falls back to `base`'s;
 * numbers are rounded and clamped to their limits, and the editor command is trimmed. Task templates are checked
 * one by one (see normalizeTaskTemplates): invalid ones are dropped, the rest kept. A budget is null (none) or a
 * positive number, rounded to cents and clamped to BUDGET_LIMITS.
 */
export function normalizeSettings(raw: unknown, base: Readonly<Settings> = DEFAULT_SETTINGS): Settings {
  const r = isRecord(raw) ? raw : {}
  const claudeArgs = Array.isArray(r.claudeArgs) && r.claudeArgs.every(isArgString) ? r.claudeArgs : base.claudeArgs
  const number = (v: unknown, fallback: number, limits: { min: number; max: number }): number =>
    clamp(Math.round(isFiniteNumber(v) ? v : fallback), limits)
  const budget = (v: unknown, fallback: number | null): number | null => {
    if (v === null) return null
    if (!isFiniteNumber(v) || v <= 0) return fallback
    return clamp(Math.round(v * 100) / 100, BUDGET_LIMITS)
  }
  return {
    claudeArgs: [...claudeArgs],
    editorCommand: isArgString(r.editorCommand) ? r.editorCommand.trim() : base.editorCommand,
    pollIntervalMs: number(r.pollIntervalMs, base.pollIntervalMs, POLL_INTERVAL_LIMITS),
    terminalFontSize: number(r.terminalFontSize, base.terminalFontSize, FONT_SIZE_LIMITS),
    notifications: typeof r.notifications === 'boolean' ? r.notifications : base.notifications,
    remoteControl: typeof r.remoteControl === 'boolean' ? r.remoteControl : base.remoteControl,
    skipPermissions: typeof r.skipPermissions === 'boolean' ? r.skipPermissions : base.skipPermissions,
    updateStrategy: UPDATE_STRATEGIES.includes(r.updateStrategy as UpdateStrategy)
      ? (r.updateStrategy as UpdateStrategy)
      : base.updateStrategy,
    cloneDirectory:
      isArgString(r.cloneDirectory) && (r.cloneDirectory.trim() === '' || r.cloneDirectory.trim().startsWith('/'))
        ? r.cloneDirectory.trim()
        : base.cloneDirectory,
    showStatusBar: typeof r.showStatusBar === 'boolean' ? r.showStatusBar : base.showStatusBar,
    taskTemplates: normalizeTaskTemplates(Array.isArray(r.taskTemplates) ? r.taskTemplates : base.taskTemplates),
    dailyBudgetUsd: budget(r.dailyBudgetUsd, base.dailyBudgetUsd),
    taskBudgetUsd: budget(r.taskBudgetUsd, base.taskBudgetUsd),
  }
}
