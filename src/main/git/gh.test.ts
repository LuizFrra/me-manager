import { describe, expect, it, vi } from 'vitest'
import { GH_INSTALL_HINT } from '../../shared/git'
import { CommandError } from '../exec'
import { baseBranchName, GH_ENV, GH_TIMEOUT_MS, GhService, prCreateArgs, prViewArgs, type GhDeps } from './gh'

const URL = 'https://github.com/acme/my-api/pull/7'
const ghError = (stderr: string, code = 1): CommandError =>
  new CommandError('gh pr create', code, stderr, `gh pr create failed: ${stderr}`)

/** A fake system: `which` finds gh at /usr/bin/gh (or nowhere), `run` answers per gh subcommand. */
function fakeDeps(opts: { installed?: boolean; create?: () => Promise<string>; view?: () => Promise<string> } = {}): {
  deps: GhDeps
  run: ReturnType<typeof vi.fn<GhDeps['run']>>
  which: ReturnType<typeof vi.fn<GhDeps['which']>>
} {
  const which = vi.fn<GhDeps['which']>(() => (opts.installed === false ? null : '/usr/bin/gh'))
  const run = vi.fn<GhDeps['run']>(async (_file: string, args: string[]) => {
    if (args[1] === 'create') return (opts.create ?? (async () => `${URL}\n`))()
    if (args[1] === 'view') return (opts.view ?? (async () => `${URL}\n`))()
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
  return { deps: { run, which }, run, which }
}

describe('gh argv', () => {
  it('builds pr create and pr view without a shell, base without origin/', () => {
    expect(prCreateArgs('claude/x/y', 'main')).toEqual([
      'pr',
      'create',
      '--fill',
      '--head',
      'claude/x/y',
      '--base',
      'main',
    ])
    expect(prViewArgs('claude/x/y')).toEqual(['pr', 'view', 'claude/x/y', '--json', 'url', '-q', '.url'])
    expect(baseBranchName('origin/main')).toBe('main')
    expect(baseBranchName('origin/release/2.0')).toBe('release/2.0')
    expect(baseBranchName('develop')).toBe('develop')
  })

  it('never lets gh or git prompt', () => {
    expect(GH_ENV).toMatchObject({ GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_DIR: undefined })
  })
})

describe('GhService', () => {
  it('looks gh up on PATH once', () => {
    const { deps, which } = fakeDeps()
    const gh = new GhService(deps)
    expect(gh.available()).toBe(true)
    expect(gh.available()).toBe(true)
    expect(which).toHaveBeenCalledTimes(1)
    expect(which).toHaveBeenCalledWith('gh')
    const missing = fakeDeps({ installed: false })
    const none = new GhService(missing.deps)
    expect(none.available()).toBe(false)
    expect(none.available()).toBe(false)
    expect(missing.which).toHaveBeenCalledTimes(1)
  })

  it('creates the pull request in the worktree, then reads its URL', async () => {
    const { deps, run } = fakeDeps()
    await expect(new GhService(deps).pullRequest('/wt/x', 'claude/x/y', 'main')).resolves.toEqual({
      url: URL,
      created: true,
    })
    const opts = { cwd: '/wt/x', env: GH_ENV, timeoutMs: GH_TIMEOUT_MS }
    expect(run.mock.calls).toEqual([
      ['/usr/bin/gh', prCreateArgs('claude/x/y', 'main'), opts],
      ['/usr/bin/gh', prViewArgs('claude/x/y'), opts],
    ])
  })

  it('opens the existing pull request when there already is one', async () => {
    const { deps } = fakeDeps({
      create: async () => {
        throw ghError(`a pull request for branch "claude/x/y" into branch "main" already exists:\n${URL}\n`)
      },
    })
    await expect(new GhService(deps).pullRequest('/wt/x', 'claude/x/y', 'main')).resolves.toEqual({
      url: URL,
      created: false,
    })
  })

  it("explains a missing gh, an unpushed branch and gh's own errors", async () => {
    const missing = fakeDeps({ installed: false })
    await expect(new GhService(missing.deps).pullRequest('/wt/x', 'b', 'main')).rejects.toThrow(GH_INSTALL_HINT)
    expect(missing.run).not.toHaveBeenCalled()

    const unpushed = fakeDeps({
      create: async () => {
        throw ghError("pull request create failed: GraphQL: Head sha can't be blank (createPullRequest)")
      },
    })
    await expect(new GhService(unpushed.deps).pullRequest('/wt/x', 'claude/x/y', 'main')).rejects.toThrow(
      "Push claude/x/y first: GitHub doesn't have it yet",
    )

    const auth = fakeDeps({
      create: async () => {
        throw ghError('To get started with GitHub CLI, please run:  gh auth login\n', 4)
      },
    })
    await expect(new GhService(auth.deps).pullRequest('/wt/x', 'claude/x/y', 'main')).rejects.toThrow(
      'gh pr create failed: To get started with GitHub CLI, please run: gh auth login',
    )
  })

  it('refuses option-like branches and a view that gives no URL', async () => {
    const { deps, run } = fakeDeps({ view: async () => 'not a url\n' })
    const gh = new GhService(deps)
    await expect(gh.pullRequest('/wt/x', '--web', 'main')).rejects.toThrow('Invalid branch: --web')
    await expect(gh.pullRequest('/wt/x', 'b', '-x')).rejects.toThrow('Invalid branch: -x')
    expect(run).not.toHaveBeenCalled()
    await expect(gh.pullRequest('/wt/x', 'b', 'main')).rejects.toThrow('gh pr view did not give a pull request URL')
  })
})
