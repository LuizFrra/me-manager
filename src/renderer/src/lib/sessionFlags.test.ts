import { describe, expect, it } from 'vitest'
import { effectiveSessionFlags } from './sessionFlags'

const flags = (
  claudeArgs: string[],
  over: { remoteControl?: boolean; skipPermissions?: boolean } = {},
): ReturnType<typeof effectiveSessionFlags> =>
  effectiveSessionFlags({ claudeArgs, remoteControl: true, skipPermissions: true, ...over })

describe('effectiveSessionFlags', () => {
  it('follows the toggles when the arguments say nothing about them', () => {
    expect(flags([])).toEqual({ remoteControl: true, skipPermissions: true })
    expect(flags(['--model', 'opus'], { remoteControl: false, skipPermissions: false })).toEqual({
      remoteControl: false,
      skipPermissions: false,
    })
  })

  it('does not skip permissions when the arguments choose a permission mode (main then leaves its flag out)', () => {
    expect(flags(['--permission-mode', 'plan']).skipPermissions).toBe(false)
    expect(flags(['--permission-mode=acceptEdits']).skipPermissions).toBe(false)
    expect(flags(['--permission-modes']).skipPermissions).toBe(true) // another option
  })

  it('skips permissions when the arguments do it themselves, whatever the toggle', () => {
    expect(flags(['--dangerously-skip-permissions'], { skipPermissions: false }).skipPermissions).toBe(true)
    expect(flags(['--permission-mode', 'bypassPermissions'], { skipPermissions: false }).skipPermissions).toBe(true)
    expect(flags(['--permission-mode=bypassPermissions']).skipPermissions).toBe(true)
  })

  it('has Remote Control on when the toggle or the arguments turn it on', () => {
    expect(flags(['--remote-control'], { remoteControl: false }).remoteControl).toBe(true)
    expect(flags(['--remote-control=my-name'], { remoteControl: false }).remoteControl).toBe(true)
    expect(flags(['--remote-controls'], { remoteControl: false }).remoteControl).toBe(false)
  })

  it("prefers main's effective flags when it reports them", () => {
    expect(
      effectiveSessionFlags({
        claudeArgs: [],
        remoteControl: true,
        skipPermissions: true,
        effective: { skipPermissions: false, remoteControl: false },
      }),
    ).toEqual({ remoteControl: false, skipPermissions: false })
    // A partial report: the rest is worked out here.
    expect(
      effectiveSessionFlags({
        claudeArgs: ['--permission-mode', 'plan'],
        remoteControl: true,
        skipPermissions: true,
        effective: { remoteControl: false },
      }),
    ).toEqual({ remoteControl: false, skipPermissions: false })
  })
})
