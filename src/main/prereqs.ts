import type { PrereqResult } from '../shared/types'
import { run } from './exec'

export async function checkPrereqs(): Promise<PrereqResult> {
  const mac = process.platform === 'darwin'
  const tools = [
    { tool: 'git', args: ['--version'], hint: mac ? 'xcode-select --install' : 'sudo apt install git' },
    { tool: 'tmux', args: ['-V'], hint: mac ? 'brew install tmux' : 'sudo apt install tmux' },
    { tool: 'claude', args: ['--version'], hint: 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup' },
  ]
  const missing: PrereqResult['missing'] = []
  for (const t of tools) {
    try {
      await run(t.tool, t.args, { timeoutMs: 10_000 })
    } catch {
      missing.push({ tool: t.tool, hint: t.hint })
    }
  }
  return { ok: missing.length === 0, missing }
}
