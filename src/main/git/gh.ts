import { GH_INSTALL_HINT } from '../../shared/git'
import type { PullRequestResult } from '../../shared/types'
import type { GhApi } from '../contracts'
import { CommandError, run, type RunOptions } from '../exec'
import { whichOnPath } from '../launch'
import { isHttpUrl } from '../urls'
import { GIT_ENV } from './gitEnv'
import { commandFailure, NON_INTERACTIVE_ENV } from './gitService'

/** Each gh call gives up after this long (it talks to GitHub). */
export const GH_TIMEOUT_MS = 60_000

/** gh never prompts (it has no terminal here), and neither does a git it runs. */
export const GH_ENV: NodeJS.ProcessEnv = {
  ...GIT_ENV,
  ...NON_INTERACTIVE_ENV,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
}

/** "origin/main" → "main": gh wants the branch name on GitHub. A local base ("main") is used as it is. */
export const baseBranchName = (baseRef: string): string =>
  baseRef.startsWith('origin/') ? baseRef.slice('origin/'.length) : baseRef

/** Title and body from the branch's commits (`--fill`); `--head` so gh never asks where to push. */
export const prCreateArgs = (branch: string, baseBranch: string): string[] => [
  'pr',
  'create',
  '--fill',
  '--head',
  branch,
  '--base',
  baseBranch,
]

export const prViewArgs = (branch: string): string[] => ['pr', 'view', branch, '--json', 'url', '-q', '.url']

/** What GhService needs from the system; injected so tests can fake it. */
export interface GhDeps {
  run: (file: string, args: string[], opts: RunOptions) => Promise<string>
  /** The executable's full path, if `cmd` is on PATH. */
  which: (cmd: string) => string | null
}

const SYSTEM: GhDeps = { run, which: (cmd) => whichOnPath(cmd, process.env.PATH) }

const alreadyExists = (err: unknown): boolean => err instanceof CommandError && /already exists/i.test(err.stderr)
/** GitHub's answer when the head branch was never pushed. */
const notPushed = (err: unknown): boolean =>
  err instanceof CommandError && /head sha can't be blank|head ref must be a branch|must first push/i.test(err.stderr)

export class GhService implements GhApi {
  /** gh's full path, null when it isn't on PATH; undefined until first asked (PATH comes from the login shell). */
  private path: string | null | undefined

  constructor(private readonly deps: GhDeps = SYSTEM) {}

  available(): boolean {
    if (this.path === undefined) this.path = this.deps.which('gh')
    return this.path !== null
  }

  async pullRequest(worktreePath: string, branch: string, baseBranch: string): Promise<PullRequestResult> {
    if (!this.available() || !this.path) throw new Error(GH_INSTALL_HINT)
    for (const name of [branch, baseBranch]) {
      if (!name || name.startsWith('-')) throw new Error(`Invalid branch: ${name}`)
    }
    const opts: RunOptions = { cwd: worktreePath, env: GH_ENV, timeoutMs: GH_TIMEOUT_MS }
    let created = true
    try {
      await this.deps.run(this.path, prCreateArgs(branch, baseBranch), opts)
    } catch (err) {
      if (!alreadyExists(err)) {
        if (notPushed(err)) throw new Error(`Push ${branch} first: GitHub doesn't have it yet`, { cause: err })
        throw commandFailure('gh pr create', err, true)
      }
      created = false
    }
    let url: string
    try {
      url = (await this.deps.run(this.path, prViewArgs(branch), opts)).trim()
    } catch (err) {
      throw commandFailure('gh pr view', err, true)
    }
    if (!isHttpUrl(url)) throw new Error(`gh pr view did not give a pull request URL: ${url.slice(0, 200)}`)
    return { url, created }
  }
}
