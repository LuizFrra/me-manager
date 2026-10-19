import { effectiveClaudeFlags } from '../../../shared/settings'
import type { EffectiveClaudeFlags, Settings } from '../../../shared/types'

/** Whether new Claude sessions really run with Remote Control on and with permission prompts skipped. */
export type SessionFlags = EffectiveClaudeFlags

/** The settings the flags follow from; main also reports what it works out itself, as `effective`. */
export type SessionFlagSettings = Pick<Settings, 'claudeArgs' | 'remoteControl' | 'skipPermissions'> & {
  effective?: Partial<SessionFlags>
}

/**
 * What the header and status bar badges show: main's own `effective` report when it has one, else the same rule
 * worked out here (shared/settings effectiveClaudeFlags), so a stand-in API without the field still shows the truth.
 */
export function effectiveSessionFlags(s: SessionFlagSettings): SessionFlags {
  return { ...effectiveClaudeFlags(s), ...s.effective }
}
