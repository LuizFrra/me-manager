import { afterEach, describe, expect, it, vi } from 'vitest'
import { Orchestrator, CLAUDE_CMD, CLAUDE_CONTINUE_CMD, FETCH_TIMEOUT_MS } from './orchestrator'
import type { AppState, Target, Task } from '../../shared/types'
import { makeDeps } from './fakes'

type Ctx = ReturnType<typeof makeDeps> & { orch: Orchestrator; themeId: string; repoId: string }

async function setup(): Promise<Ctx> {
  const ctx = makeDeps()
  ctx.git.roots.set('/code/my-api/src', '/code/my-api')
  const orch = new Orchestrator(ctx.deps)
  await orch.init()
  let s = await orch.createTheme('Client X')
  const themeId = s.themes[0].id
  s = await orch.addRepo(themeId, '/code/my-api/src')
  const repoId = s.themes[0].items[0].id
  return { ...ctx, orch, themeId, repoId }
}

const taskOf = (s: AppState): Task => {
  const repo = s.themes[0].items[0]
  if (repo.kind !== 'repo') throw new Error('expected repo')
  return repo.tasks[0]
}

describe('Orchestrator: themes and items', () => {
  it('persists a new theme', async () => {
    const { store, orch } = await setup()
    expect(store.saved.at(-1)?.themes[0].name).toBe('Client X')
    expect((await orch.getState()).themes).toHaveLength(1)
  })
  it('stores the repo top-level path', async () => {
    const { orch } = await setup()
    expect((await orch.getState()).themes[0].items[0].path).toBe('/code/my-api')
  })
  it('rejects non-repos', async () => {
    const { orch, themeId } = await setup()
    await expect(orch.addRepo(themeId, '/not/a/repo')).rejects.toThrow(/Not a git repository/)
  })
  it('kills the folder session when removing a folder', async () => {
    const { orch, tmux, themeId } = await setup()
    const s = await orch.addFolder(themeId, '/docs/notes')
    const folderId = s.themes[0].items[1].id
    await orch.openTarget({ themeId, itemId: folderId })
    await orch.removeItem(themeId, folderId)
    expect(tmux.calls).toContain('killSession mmf_client-x_notes')
  })
})

describe('Orchestrator: createTask', () => {
  it('fetches, creates worktree + session, and saves', async () => {
    const { orch, git, tmux, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'Fix Login Bug'))
    expect(task).toMatchObject({
      name: 'Fix Login Bug',
      slug: 'fix-login-bug',
      branch: 'claude/client-x/fix-login-bug',
      worktreePath: '/wt/client-x/my-api/fix-login-bug',
      baseRef: 'origin/main',
    })
    expect(git.calls).toEqual([
      'fetch /code/my-api',
      'addWorktree /wt/client-x/my-api/fix-login-bug claude/client-x/fix-login-bug origin/main',
    ])
    expect(tmux.calls).toContain(`newSession mmt_client-x_my-api_fix-login-bug ${CLAUDE_CMD}`)
  })
  it('continues when fetch fails (offline)', async () => {
    const { orch, git, themeId, repoId } = await setup()
    git.failFetch = true
    await expect(orch.createTask(themeId, repoId, 'x')).resolves.toBeDefined()
  })
  it('rejects duplicate names before touching git', async () => {
    const { orch, git, themeId, repoId } = await setup()
    await orch.createTask(themeId, repoId, 'fix')
    git.calls = []
    await expect(orch.createTask(themeId, repoId, 'FIX')).rejects.toThrow(/already exists/)
    expect(git.calls).toEqual([])
  })
  it('rolls back the worktree and branch when tmux fails', async () => {
    const { orch, git, tmux, store, themeId, repoId } = await setup()
    tmux.failNewSession = true
    const savesBefore = store.saved.length
    await expect(orch.createTask(themeId, repoId, 'fix')).rejects.toThrow('tmux failed')
    expect(git.calls).toContain('removeWorktree /wt/client-x/my-api/fix')
    expect(git.calls).toContain('deleteBranch claude/client-x/fix')
    expect(store.saved.length).toBe(savesBefore)
  })
})

describe('Orchestrator: removeTask', () => {
  it('detaches, kills the session, removes the worktree and optionally the branch', async () => {
    const { orch, git, tmux, pty, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await orch.openTarget({ themeId, itemId: repoId, taskId: task.id })
    const s = await orch.removeTask(themeId, repoId, task.id, true)
    expect(pty.detached).toBeGreaterThan(0)
    expect(tmux.sessions.size).toBe(0)
    expect(git.calls).toContain('removeWorktree /wt/client-x/my-api/fix')
    expect(git.calls).toContain('deleteBranch claude/client-x/fix')
    expect(taskOf(s)).toBeUndefined()
  })
  it('keeps the branch when asked', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await orch.removeTask(themeId, repoId, task.id, false)
    expect(git.calls).not.toContain('deleteBranch claude/client-x/fix')
  })
  it('removes a task whose original repo was moved or deleted, then its repo and theme', async () => {
    const { orch, git, themeId, repoId, deps } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    deps.pathExists = (p) => p !== '/code/my-api'
    git.calls = []
    const s = await orch.removeTask(themeId, repoId, task.id, true)
    expect(taskOf(s)).toBeUndefined()
    expect(git.calls).toEqual(['removeWorktree /wt/client-x/my-api/fix'])
    await expect(orch.removeItem(themeId, repoId)).resolves.toBeDefined()
    await expect(orch.removeTheme(themeId)).resolves.toEqual({ version: 1, themes: [] })
  })
  it('reports unsaved work from git', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    git.unsaved = { uncommittedFiles: ['a.ts'], unpushedCommits: [] }
    await expect(orch.checkTaskRemoval(themeId, repoId, task.id)).resolves.toEqual(git.unsaved)
  })
})

describe('Orchestrator: sessions and tabs', () => {
  async function withTask(): Promise<Ctx & { task: Task; target: Target }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    return { ...ctx, task, target }
  }

  it('attaches to an existing session without recreating it', async () => {
    const { orch, tmux, pty, target } = await withTask()
    tmux.calls = []
    const tabs = await orch.openTarget(target)
    expect(tmux.calls).toEqual([])
    expect(pty.attached?.args).toEqual(['attach', 'mmt_client-x_my-api_fix'])
    expect(pty.attached?.cwd).toBe('/wt/client-x/my-api/fix')
    expect(tabs).toEqual([{ index: 0, name: 'claude', active: true }])
  })

  it('recreates a missing session with claude --continue', async () => {
    const { orch, tmux, target } = await withTask()
    tmux.sessions.clear() // e.g. after a reboot
    await orch.openTarget(target)
    expect(tmux.calls).toContain(`newSession mmt_client-x_my-api_fix ${CLAUDE_CONTINUE_CMD}`)
  })

  it('refuses to open a task whose worktree is missing', async () => {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    ctx.deps.pathExists = () => false
    await expect(ctx.orch.openTarget({ themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id })).rejects.toThrow(
      /Folder not found/,
    )
  })

  it('lets the latest openTarget win when an earlier one finishes last', async () => {
    const ctx = await withTask()
    const { orch, tmux, pty, themeId, repoId, target: a } = ctx
    const repo = (await orch.createTask(themeId, repoId, 'other')).themes[0].items[0]
    if (repo.kind !== 'repo') throw new Error('expected repo')
    const b = { themeId, itemId: repoId, taskId: repo.tasks[1].id }
    tmux.sessions.clear() // A must be recreated (slow path)

    let releaseA: () => void = () => {}
    const aGate = new Promise<void>((r) => (releaseA = r))
    const hasSession = tmux.hasSession.bind(tmux)
    tmux.hasSession = async (name: string): Promise<boolean> => {
      if (name === 'mmt_client-x_my-api_fix') await aGate
      return hasSession(name)
    }

    const openA = orch.openTarget(a)
    await orch.openTarget(b)
    expect(pty.attached?.args).toEqual(['attach', 'mmt_client-x_my-api_other'])
    releaseA()
    const tabsA = await openA
    expect(pty.attached?.args).toEqual(['attach', 'mmt_client-x_my-api_other'])
    expect(tabsA).toEqual([{ index: 0, name: 'claude', active: true }])

    // B is still the current target: removing A must not detach the terminal.
    const detachedBefore = pty.detached
    await orch.removeTask(themeId, repoId, a.taskId!, false)
    expect(pty.detached).toBe(detachedBefore)
  })

  it('names new shell tabs uniquely', async () => {
    const { orch, target } = await withTask()
    await orch.newTab(target)
    const tabs = await orch.newTab(target)
    expect(tabs.map((t) => t.name)).toEqual(['claude', 'shell', 'shell 2'])
    expect(tabs[2].active).toBe(true)
  })

  it('restarts claude in a new window when it was closed', async () => {
    const { orch, target } = await withTask()
    await orch.newTab(target)
    await orch.closeTab(target, 0)
    const tabs = await orch.restartClaude(target)
    expect(tabs.map((t) => t.name)).toEqual(['shell', 'claude'])
  })

  it('returns no tabs after the last window closes', async () => {
    const { orch, target } = await withTask()
    await expect(orch.closeTab(target, 0)).resolves.toEqual([])
  })

  it('reports running sessions and missing paths', async () => {
    const ctx = await withTask()
    let status = await ctx.orch.getStatus()
    expect(status).toEqual({ running: [ctx.task.id], missing: [] })
    ctx.tmux.sessions.clear()
    ctx.deps.pathExists = (p) => p !== '/wt/client-x/my-api/fix'
    status = await ctx.orch.getStatus()
    expect(status).toEqual({ running: [], missing: [ctx.task.id] })
  })
})

describe('Orchestrator: serialized mutations', () => {
  it('lets only one of two concurrent identical createTask calls succeed', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const results = await Promise.allSettled([
      orch.createTask(themeId, repoId, 'fix'),
      orch.createTask(themeId, repoId, 'fix'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/already exists/)
    expect(git.calls.filter((c) => c.startsWith('addWorktree'))).toHaveLength(1)
    expect(git.calls).not.toContain('removeWorktree /wt/client-x/my-api/fix')
    expect(taskOf(await orch.getState()).slug).toBe('fix')
  })

  it('never runs two store saves at once and loses no update', async () => {
    const ctx = makeDeps()
    let inFlight = 0
    let maxInFlight = 0
    const save = ctx.store.save.bind(ctx.store)
    ctx.store.save = async (state): Promise<void> => {
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await new Promise((r) => setTimeout(r, 5))
      await save(state)
      inFlight--
    }
    const orch = new Orchestrator(ctx.deps)
    await orch.init()
    await Promise.all([orch.createTheme('A'), orch.createTheme('B'), orch.createTheme('C')])
    expect(maxInFlight).toBe(1)
    expect((await orch.getState()).themes.map((t) => t.name)).toEqual(['A', 'B', 'C'])
    expect(ctx.store.saved.at(-1)?.themes).toHaveLength(3)
  })

  it('does not let a rejected operation block the next one', async () => {
    const { orch, themeId } = await setup()
    const [dup, next] = await Promise.allSettled([orch.createTheme('Client X'), orch.createTheme('Other')])
    expect(dup.status).toBe('rejected')
    expect(next.status).toBe('fulfilled')
    await expect(orch.addRepo(themeId, '/not/a/repo')).rejects.toThrow(/Not a git repository/)
    await expect(orch.addFolder(themeId, '/docs/notes')).resolves.toBeDefined()
    expect((await orch.getState()).themes.map((t) => t.name)).toEqual(['Client X', 'Other'])
  })
})

describe('Orchestrator: fetch timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults to 20 seconds', () => {
    expect(FETCH_TIMEOUT_MS).toBe(20_000)
  })

  it('creates the task from the last fetched refs when fetch hangs', async () => {
    const ctx = makeDeps()
    ctx.git.roots.set('/code/my-api', '/code/my-api')
    ctx.git.fetch = (): Promise<void> => new Promise(() => {}) // never settles
    const orch = new Orchestrator(ctx.deps, { fetchTimeoutMs: 10 })
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    const repoId = (await orch.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    expect(task.baseRef).toBe('origin/main')
    expect(ctx.git.calls).toContain('addWorktree /wt/client-x/my-api/fix claude/client-x/fix origin/main')
  })

  it('waits FETCH_TIMEOUT_MS by default before giving up on fetch', async () => {
    vi.useFakeTimers()
    const { orch, git, themeId, repoId } = await setup()
    git.fetch = (): Promise<void> => new Promise(() => {})
    let done = false
    const p = orch.createTask(themeId, repoId, 'fix').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(done).toBe(true)
  })

  it('clears the timer once fetch settles', async () => {
    vi.useFakeTimers()
    const { orch, themeId, repoId } = await setup()
    await orch.createTask(themeId, repoId, 'fix')
    expect(vi.getTimerCount()).toBe(0)
  })
})
