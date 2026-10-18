import { UPDATE_STRATEGIES, type Settings, type UpdateStrategy } from './types'

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
})

export const clamp = (n: number, { min, max }: { min: number; max: number }): number => Math.min(max, Math.max(min, n))

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A NUL can't be part of a command-line argument. */
const isArgString = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Turns anything (a parsed settings.json, a renderer's patch merged over the current settings) into valid
 * Settings. Known keys only; unknown ones are dropped. A missing or wrongly typed value falls back to `base`'s;
 * numbers are rounded and clamped to their limits, and the editor command is trimmed.
 */
export function normalizeSettings(raw: unknown, base: Readonly<Settings> = DEFAULT_SETTINGS): Settings {
  const r = isRecord(raw) ? raw : {}
  const claudeArgs = Array.isArray(r.claudeArgs) && r.claudeArgs.every(isArgString) ? r.claudeArgs : base.claudeArgs
  const number = (v: unknown, fallback: number, limits: { min: number; max: number }): number =>
    clamp(Math.round(isFiniteNumber(v) ? v : fallback), limits)
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
  }
}
