import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Orchestrator,
  CLAUDE_CMD,
  CLAUDE_CONTINUE_CMD,
  FETCH_TIMEOUT_MS,
  GIT_STATUS_CONCURRENCY,
  GIT_STATUS_TTL_MS,
  claudeCommand,
  claudeContinueCommand,
} from './orchestrator'
import type { AppState, Target, Task, TaskGitStatus } from '../../shared/types'
import { emptyUsageSummary } from '../../shared/usage'
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

describe('Orchestrator: rename', () => {
  it('renames a theme and saves, keeping slugs, branches and paths', async () => {
    const { orch, store, themeId, repoId } = await setup()
    const before = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    const s = await orch.renameTheme(themeId, '  Client Y ')
    expect(s.themes[0]).toMatchObject({ name: 'Client Y', slug: 'client-x' })
    expect(taskOf(s)).toEqual(before)
    expect(store.saved.at(-1)).toEqual(s)
    expect(await orch.getState()).toBe(s)
  })

  it('renames a task without touching git or tmux, and the session still resolves', async () => {
    const { orch, git, tmux, pty, store, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    git.calls = []
    tmux.calls = []
    const s = await orch.renameTask(themeId, repoId, task.id, 'Fix the login flow')
    expect(taskOf(s)).toEqual({ ...task, name: 'Fix the login flow' })
    expect(store.saved.at(-1)).toEqual(s)
    expect(git.calls).toEqual([])
    expect(tmux.calls).toEqual([])
    await orch.openTarget({ themeId, itemId: repoId, taskId: task.id })
    expect(pty.attached?.args).toEqual(['attach', 'mmt_client-x_my-api_fix'])
  })

  it('rejects empty and duplicate names without saving', async () => {
    const { orch, store, themeId, repoId } = await setup()
    await orch.createTheme('Personal')
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await orch.createTask(themeId, repoId, 'docs')
    const saves = store.saved.length
    await expect(orch.renameTheme(themeId, 'personal')).rejects.toThrow(/already exists/)
    await expect(orch.renameTask(themeId, repoId, task.id, ' ')).rejects.toThrow("Task name can't be empty")
    await expect(orch.renameTask(themeId, repoId, task.id, 'Docs')).rejects.toThrow(/already exists/)
    expect(store.saved.length).toBe(saves)
  })

  it('rejects a new task named like a renamed one before touching git', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await orch.renameTask(themeId, repoId, task.id, 'Login')
    git.calls = []
    await expect(orch.createTask(themeId, repoId, 'login')).rejects.toThrow(/already exists/)
    expect(git.calls).toEqual([])
  })

  it('serializes renames with other mutations', async () => {
    const { orch, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await Promise.all([orch.renameTask(themeId, repoId, task.id, 'A'), orch.createTask(themeId, repoId, 'other')])
    const repo = (await orch.getState()).themes[0].items[0]
    expect(repo.kind === 'repo' && repo.tasks.map((t) => t.name)).toEqual(['A', 'other'])
  })
})

describe('Orchestrator: task notes', () => {
  it('saves notes and clears them with an empty string', async () => {
    const { orch, store, git, tmux, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    git.calls = []
    tmux.calls = []
    let s = await orch.setTaskNotes(themeId, repoId, task.id, 'Blocked on review')
    expect(taskOf(s).notes).toBe('Blocked on review')
    expect(store.saved.at(-1)).toEqual(s)
    s = await orch.setTaskNotes(themeId, repoId, task.id, '')
    expect(taskOf(s)).toEqual(task)
    expect(git.calls).toEqual([])
    expect(tmux.calls).toEqual([])
  })

  it('rejects notes over the limit without saving, and keeps the queue going', async () => {
    const { orch, store, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    const saves = store.saved.length
    const [tooLong, ok] = await Promise.allSettled([
      orch.setTaskNotes(themeId, repoId, task.id, 'x'.repeat(2001)),
      orch.setTaskNotes(themeId, repoId, task.id, 'fine'),
    ])
    expect(tooLong.status).toBe('rejected')
    expect(ok.status).toBe('fulfilled')
    expect(store.saved.length).toBe(saves + 1)
    expect(taskOf(await orch.getState()).notes).toBe('fine')
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
    expect(status).toEqual({ running: [ctx.task.id], missing: [], activity: {} })
    ctx.tmux.sessions.clear()
    ctx.deps.pathExists = (p) => p !== '/wt/client-x/my-api/fix'
    status = await ctx.orch.getStatus()
    expect(status).toEqual({ running: [], missing: [ctx.task.id], activity: {} })
  })
})

describe('Orchestrator: settings and claude arguments', () => {
  it('builds the claude commands, shell-quoting every argument', () => {
    expect(CLAUDE_CMD).toBe('claude')
    expect(CLAUDE_CONTINUE_CMD).toBe('claude --continue || claude')
    expect(claudeCommand(['--model', 'opus'])).toBe('claude --model opus')
    expect(claudeContinueCommand(['--model', 'opus'])).toBe('claude --model opus --continue || claude --model opus')
    expect(claudeCommand(['--append-system-prompt', "be brief; don't $(rm -rf ~)"])).toBe(
      `claude --append-system-prompt 'be brief; don'\\''t $(rm -rf ~)'`,
    )
  })

  it('reads and updates settings through the settings service', async () => {
    const { orch, settings } = await setup()
    expect(await orch.getSettings()).toMatchObject({ claudeArgs: [], pollIntervalMs: 3000 })
    const next = await orch.updateSettings({ claudeArgs: ['--model', 'opus'], pollIntervalMs: 99 })
    expect(next).toMatchObject({ claudeArgs: ['--model', 'opus'], pollIntervalMs: 1000 })
    expect(settings.get()).toEqual(next)
    expect(await orch.getSettings()).toEqual(next)
  })

  it('passes the arguments to new tasks, recreated sessions and restarted Claude windows', async () => {
    const { orch, tmux, themeId, repoId } = await setup()
    await orch.updateSettings({ claudeArgs: ['--model', 'opus', 'two words'] })
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    expect(tmux.calls).toContain(`newSession mmt_client-x_my-api_fix claude --model opus 'two words'`)

    const target = { themeId, itemId: repoId, taskId: task.id }
    tmux.sessions.clear()
    await orch.openTarget(target)
    expect(tmux.calls.at(-1)).toBe(
      `newSession mmt_client-x_my-api_fix claude --model opus 'two words' --continue || claude --model opus 'two words'`,
    )

    await orch.newTab(target)
    await orch.closeTab(target, 0)
    await orch.restartClaude(target)
    const windows = tmux.sessions.get('mmt_client-x_my-api_fix')?.windows
    expect(windows?.at(-1)).toEqual({
      name: 'claude',
      command: `claude --model opus 'two words' --continue || claude --model opus 'two words'`,
    })
  })

  it('uses arguments saved after a session started only for the next one', async () => {
    const { orch, tmux, themeId, repoId } = await setup()
    await orch.createTask(themeId, repoId, 'a')
    await orch.updateSettings({ claudeArgs: ['-v'] })
    await orch.createTask(themeId, repoId, 'b')
    expect(tmux.calls.filter((c) => c.startsWith('newSession'))).toEqual([
      'newSession mmt_client-x_my-api_a claude',
      'newSession mmt_client-x_my-api_b claude -v',
    ])
  })
})

describe('Orchestrator: Remote Control and skipped permissions', () => {
  it('starts every Claude session with Remote Control named after the task and permissions skipped', async () => {
    const { orch, tmux, themeId, repoId } = await setup()
    await orch.updateSettings({ remoteControl: true, skipPermissions: true })
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    const flags = '--remote-control client-x/my-api/fix --dangerously-skip-permissions'
    expect(tmux.calls).toContain(`newSession mmt_client-x_my-api_fix claude ${flags}`)

    tmux.sessions.clear()
    await orch.openTarget({ themeId, itemId: repoId, taskId: task.id })
    expect(tmux.calls.at(-1)).toBe(`newSession mmt_client-x_my-api_fix claude ${flags} --continue || claude ${flags}`)
  })

  it('names folder sessions after the theme and folder', async () => {
    const { orch, tmux, themeId } = await setup()
    await orch.updateSettings({ remoteControl: true, skipPermissions: false })
    const s = await orch.addFolder(themeId, '/docs/notes')
    await orch.openTarget({ themeId, itemId: s.themes[0].items[1].id })
    expect(tmux.calls.at(-1)).toBe(
      'newSession mmf_client-x_notes claude --remote-control client-x/notes --continue || claude --remote-control client-x/notes',
    )
  })

  it('puts the user arguments after the built-in flags', async () => {
    const { orch, tmux, themeId, repoId } = await setup()
    await orch.updateSettings({ remoteControl: false, skipPermissions: true, claudeArgs: ['--model', 'opus'] })
    await orch.createTask(themeId, repoId, 'fix')
    expect(tmux.calls).toContain(
      'newSession mmt_client-x_my-api_fix claude --dangerously-skip-permissions --model opus',
    )
  })

  it('does not duplicate options the user already set in their own arguments', async () => {
    const { orch, tmux, themeId, repoId } = await setup()
    await orch.updateSettings({
      remoteControl: true,
      skipPermissions: true,
      claudeArgs: ['--remote-control', 'mine', '--permission-mode', 'acceptEdits'],
    })
    await orch.createTask(themeId, repoId, 'fix')
    expect(tmux.calls).toContain(
      'newSession mmt_client-x_my-api_fix claude --remote-control mine --permission-mode acceptEdits',
    )
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

describe('Orchestrator: file viewer', () => {
  async function withTaskAndFolder(): Promise<Ctx & { task: Task; taskTarget: Target; folderTarget: Target }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const s = await ctx.orch.addFolder(ctx.themeId, '/docs/notes')
    const folderId = s.themes[0].items[1].id
    return {
      ...ctx,
      task,
      taskTarget: { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id },
      folderTarget: { themeId: ctx.themeId, itemId: folderId },
    }
  }

  it('lists a task worktree as a repo', async () => {
    const { orch, files, taskTarget } = await withTaskAndFolder()
    await orch.listFiles(taskTarget)
    expect(files.calls).toEqual(['listFiles /wt/client-x/my-api/fix true'])
  })

  it('lists a folder as a plain folder', async () => {
    const { orch, files, folderTarget } = await withTaskAndFolder()
    await orch.listFiles(folderTarget)
    expect(files.calls).toEqual(['listFiles /docs/notes false'])
  })

  it('returns what the files service returns', async () => {
    const { orch, files, taskTarget } = await withTaskAndFolder()
    files.listFiles = async () => ({ paths: ['a.ts', 'b/c.md'], truncated: true })
    await expect(orch.listFiles(taskTarget)).resolves.toEqual({ paths: ['a.ts', 'b/c.md'], truncated: true })
  })

  it('reads files and images relative to the root', async () => {
    const { orch, files, taskTarget, folderTarget } = await withTaskAndFolder()
    await orch.readFile(taskTarget, 'src/a.ts')
    await orch.readImage(folderTarget, 'img/logo.png')
    expect(files.calls).toEqual(['readFile /wt/client-x/my-api/fix src/a.ts', 'readImage /docs/notes img/logo.png'])
  })

  it("passes the task's baseRef to listChanges and fileDiff", async () => {
    const { orch, files, taskTarget } = await withTaskAndFolder()
    await orch.listChanges(taskTarget)
    await orch.fileDiff(taskTarget, 'src/a.ts')
    await orch.fileDiff(taskTarget, 'src/b.ts', 'src/old-b.ts')
    expect(files.calls).toEqual([
      'listChanges /wt/client-x/my-api/fix origin/main',
      'fileDiff /wt/client-x/my-api/fix origin/main src/a.ts',
      'fileDiff /wt/client-x/my-api/fix origin/main src/b.ts (from src/old-b.ts)',
    ])
  })

  it('rejects changes and diffs for folders', async () => {
    const { orch, files, folderTarget } = await withTaskAndFolder()
    await expect(orch.listChanges(folderTarget)).rejects.toThrow('Changes are only available for repository tasks')
    await expect(orch.fileDiff(folderTarget, 'a.md')).rejects.toThrow('Changes are only available for repository tasks')
    expect(files.calls).toEqual([])
  })

  it('rejects a repo target without a task', async () => {
    const { orch, files, themeId, repoId } = await withTaskAndFolder()
    await expect(orch.listFiles({ themeId, itemId: repoId })).rejects.toThrow('Choose a task to open')
    expect(files.calls).toEqual([])
  })

  it('rejects when the root is missing', async () => {
    const { orch, files, deps, taskTarget, folderTarget } = await withTaskAndFolder()
    deps.pathExists = () => false
    await expect(orch.listFiles(taskTarget)).rejects.toThrow('Folder not found: /wt/client-x/my-api/fix')
    await expect(orch.readFile(folderTarget, 'a.md')).rejects.toThrow('Folder not found: /docs/notes')
    await expect(orch.readImage(folderTarget, 'a.png')).rejects.toThrow('Folder not found: /docs/notes')
    await expect(orch.listChanges(taskTarget)).rejects.toThrow('Folder not found')
    await expect(orch.fileDiff(taskTarget, 'a.ts')).rejects.toThrow('Folder not found')
    expect(files.calls).toEqual([])
  })

  it('does not wait for queued mutations', async () => {
    const { orch, files, git, themeId, repoId, taskTarget } = await withTaskAndFolder()
    let release!: () => void
    git.fetch = () => new Promise<void>((resolve) => (release = resolve))
    const pending = orch.createTask(themeId, repoId, 'slow')
    await orch.listFiles(taskTarget)
    expect(files.calls).toEqual(['listFiles /wt/client-x/my-api/fix true'])
    release()
    await pending
  })
})

describe('Orchestrator: open in editor / file manager', () => {
  async function withTargets(): Promise<Ctx & { taskTarget: Target; folderTarget: Target }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const s = await ctx.orch.addFolder(ctx.themeId, '/docs/notes')
    return {
      ...ctx,
      taskTarget: { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id },
      folderTarget: { themeId: ctx.themeId, itemId: s.themes[0].items[1].id },
    }
  }

  it("opens a task's worktree and a folder's path, with the editor command from Settings", async () => {
    const { orch, launcher, taskTarget, folderTarget } = await withTargets()
    await orch.openInEditor(taskTarget)
    await orch.updateSettings({ editorCommand: 'subl -n' })
    await orch.openInEditor(folderTarget)
    await orch.openInFileManager(taskTarget)
    await orch.openInFileManager(folderTarget)
    expect(launcher.calls).toEqual([
      'editor /wt/client-x/my-api/fix []',
      'editor /docs/notes [subl -n]',
      'fileManager /wt/client-x/my-api/fix',
      'fileManager /docs/notes',
    ])
  })

  it('refuses a missing folder or a repo without a task, before launching anything', async () => {
    const ctx = await withTargets()
    ctx.deps.pathExists = (p) => p !== '/docs/notes'
    await expect(ctx.orch.openInEditor(ctx.folderTarget)).rejects.toThrow('Folder not found: /docs/notes')
    await expect(ctx.orch.openInFileManager(ctx.folderTarget)).rejects.toThrow(/Folder not found/)
    await expect(ctx.orch.openInEditor({ themeId: ctx.themeId, itemId: ctx.repoId })).rejects.toThrow(/Choose a task/)
    expect(ctx.launcher.calls).toEqual([])
  })

  it("passes on the launcher's error", async () => {
    const { orch, launcher, taskTarget } = await withTargets()
    launcher.fail = 'No editor found — set one in Settings'
    await expect(orch.openInEditor(taskTarget)).rejects.toThrow('No editor found — set one in Settings')
  })
})

describe('Orchestrator: usage', () => {
  const summary = (cost: number): ReturnType<typeof emptyUsageSummary> => {
    const s = emptyUsageSummary()
    s.all.cost = cost
    return s
  }

  async function withTargets(): Promise<Ctx & { taskTarget: Target; folderTarget: Target; otherTheme: string }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const s = await ctx.orch.addFolder(ctx.themeId, '/docs/notes')
    const other = await ctx.orch.createTheme('Personal')
    const otherTheme = other.themes[1].id
    await ctx.orch.addFolder(otherTheme, '/home/me/blog')
    return {
      ...ctx,
      otherTheme,
      taskTarget: { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id },
      folderTarget: { themeId: ctx.themeId, itemId: s.themes[0].items[1].id },
    }
  }

  it("returns a target's usage, asking for every known root so each message counts once", async () => {
    const { orch, usage, taskTarget, folderTarget } = await withTargets()
    usage.byRoot['/wt/client-x/my-api/fix'] = summary(1.5)
    usage.byRoot['/docs/notes'] = summary(0.25)
    expect((await orch.getUsage(taskTarget)).all.cost).toBe(1.5)
    expect((await orch.getUsage(folderTarget)).all.cost).toBe(0.25)
    expect(usage.calls[0].roots).toEqual(['/wt/client-x/my-api/fix', '/docs/notes', '/home/me/blog'])
  })

  it('works for a target whose folder is gone, but not for a repo without a task', async () => {
    const ctx = await withTargets()
    ctx.deps.pathExists = () => false
    expect((await ctx.orch.getUsage(ctx.folderTarget)).all.messages).toBe(0)
    await expect(ctx.orch.getUsage({ themeId: ctx.themeId, itemId: ctx.repoId })).rejects.toThrow(/Choose a task/)
  })

  it('reports every target per theme, with theme and grand totals', async () => {
    const { orch, usage, themeId, otherTheme } = await withTargets()
    usage.byRoot['/home/me/blog'] = summary(3)
    usage.byGroup.total = summary(10)
    usage.byGroup[`theme:${themeId}`] = summary(7)
    const report = await orch.getUsageReport()
    expect(usage.calls[0].groups).toEqual({
      total: ['/wt/client-x/my-api/fix', '/docs/notes', '/home/me/blog'],
      [`theme:${themeId}`]: ['/wt/client-x/my-api/fix', '/docs/notes'],
      [`theme:${otherTheme}`]: ['/home/me/blog'],
    })
    expect(report.total.all.cost).toBe(10)
    expect(report.themes.map((t) => [t.name, t.usage.all.cost])).toEqual([
      ['Client X', 7],
      ['Personal', 0],
    ])
    expect(report.themes[0].targets.map((t) => [t.kind, t.label, t.path])).toEqual([
      ['task', 'my-api › fix', '/wt/client-x/my-api/fix'],
      ['folder', 'notes', '/docs/notes'],
    ])
    expect(report.themes[1].targets[0].usage.all.cost).toBe(3)
  })
})

describe('Orchestrator: git status', () => {
  const clean = (branch: string): TaskGitStatus => ({ ahead: 0, behind: 0, uncommitted: 0, branch })

  async function withTasks(
    names: string[],
  ): Promise<Ctx & { clock: { now: number }; targets: Target[]; tasks: Task[] }> {
    const ctx = makeDeps()
    ctx.git.roots.set('/code/my-api', '/code/my-api')
    const clock = { now: 1_000_000 }
    const orch = new Orchestrator(ctx.deps, { now: () => clock.now })
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    const repoId = (await orch.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    let state: AppState = await orch.getState()
    for (const name of names) state = await orch.createTask(themeId, repoId, name)
    const repo = state.themes[0].items[0]
    if (repo.kind !== 'repo') throw new Error('expected repo')
    for (const task of repo.tasks) ctx.git.statuses.set(task.worktreePath, clean(task.branch))
    const targets = repo.tasks.map((t) => ({ themeId, itemId: repoId, taskId: t.id }))
    return { ...ctx, orch, themeId, repoId, clock, targets, tasks: repo.tasks }
  }

  it('returns each task status by task id, passing the task base ref', async () => {
    const { orch, git, targets, tasks } = await withTasks(['a', 'b'])
    git.statuses.set(tasks[0].worktreePath, { ahead: 3, behind: 1, uncommitted: 2, branch: tasks[0].branch })
    const result = await orch.getGitStatus(targets)
    expect(result).toEqual({
      [tasks[0].id]: { ahead: 3, behind: 1, uncommitted: 2, branch: tasks[0].branch },
      [tasks[1].id]: clean(tasks[1].branch),
    })
    expect(git.statusCalls).toEqual(['/wt/client-x/my-api/a origin/main', '/wt/client-x/my-api/b origin/main'])
  })

  it('skips folders, unknown targets, missing worktrees and failed reads', async () => {
    const ctx = await withTasks(['a', 'b', 'c'])
    const { orch, git, deps, themeId, targets, tasks } = ctx
    const folderId = (await orch.addFolder(themeId, '/docs')).themes[0].items[1].id
    deps.pathExists = (p) => p !== tasks[1].worktreePath
    git.statuses.delete(tasks[2].worktreePath) // git fails there
    const result = await orch.getGitStatus([
      ...targets,
      { themeId, itemId: folderId },
      { themeId, itemId: ctx.repoId, taskId: 'gone' },
    ])
    expect(Object.keys(result)).toEqual([tasks[0].id])
    expect(git.statusCalls).toEqual(['/wt/client-x/my-api/a origin/main', '/wt/client-x/my-api/c origin/main'])
  })

  it('reuses a worktree status for GIT_STATUS_TTL_MS, then reads it again', async () => {
    const { orch, git, clock, targets } = await withTasks(['a'])
    await orch.getGitStatus(targets)
    clock.now += GIT_STATUS_TTL_MS - 1 // a faster poll
    await orch.getGitStatus(targets)
    expect(git.statusCalls).toHaveLength(1)
    clock.now += 1
    await orch.getGitStatus(targets)
    expect(git.statusCalls).toHaveLength(2)
  })

  it('shares one read between overlapping calls and caches failures for the TTL too', async () => {
    const { orch, git, clock, targets, tasks } = await withTasks(['a'])
    let release: () => void = () => {}
    git.statusGate = new Promise((r) => (release = r))
    const first = orch.getGitStatus(targets)
    const second = orch.getGitStatus(targets)
    release()
    expect(await first).toEqual(await second)
    expect(git.statusCalls).toHaveLength(1)

    git.statusGate = null
    git.statuses.delete(tasks[0].worktreePath)
    clock.now += GIT_STATUS_TTL_MS
    await expect(orch.getGitStatus(targets)).resolves.toEqual({})
    await expect(orch.getGitStatus(targets)).resolves.toEqual({})
    expect(git.statusCalls).toHaveLength(2)
  })

  it(`reads at most ${GIT_STATUS_CONCURRENCY} worktrees at once`, async () => {
    const { orch, git, targets } = await withTasks(['a', 'b', 'c', 'd', 'e', 'f'])
    let release: () => void = () => {}
    git.statusGate = new Promise((r) => (release = r))
    const pending = orch.getGitStatus(targets)
    await new Promise((r) => setTimeout(r, 0))
    expect(git.inFlightStatus).toBe(GIT_STATUS_CONCURRENCY)
    release()
    expect(Object.keys(await pending)).toHaveLength(6)
    expect(git.peakInFlightStatus).toBe(GIT_STATUS_CONCURRENCY)
  })

  it('ignores a non-array argument', async () => {
    const { orch } = await withTasks(['a'])
    await expect(orch.getGitStatus(null as unknown as Target[])).resolves.toEqual({})
  })
})

describe('Orchestrator: Claude activity', () => {
  const PROMPT = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n'
  const INPUT = '⏺ Done.\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n'

  async function withSessions(): Promise<
    Ctx & { clock: { now: number }; task: Task; folderId: string; taskSession: string; folderSession: string }
  > {
    const ctx = makeDeps()
    ctx.git.roots.set('/code/my-api', '/code/my-api')
    const clock = { now: 1_700_000_000_500 }
    const orch = new Orchestrator(ctx.deps, { now: () => clock.now })
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    const repoId = (await orch.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    const folderId = (await orch.addFolder(themeId, '/docs/notes')).themes[0].items[1].id
    await orch.openTarget({ themeId, itemId: folderId }) // starts the folder session
    return {
      ...ctx,
      orch,
      themeId,
      repoId,
      clock,
      task,
      folderId,
      taskSession: 'mmt_client-x_my-api_fix',
      folderSession: 'mmf_client-x_notes',
    }
  }
  const secondsAgo = (clock: { now: number }, s: number): number => Math.floor(clock.now / 1000) - s

  it('is busy after recent output, without capturing the screen', async () => {
    const { orch, tmux, clock, task, taskSession } = await withSessions()
    tmux.activity.set(taskSession, secondsAgo(clock, 1))
    tmux.panes.set(taskSession, PROMPT)
    expect((await orch.getStatus()).activity).toEqual({ [task.id]: 'busy' })
    expect(tmux.captureCalls).toEqual([])
  })

  it('is waiting or idle from the screen of a quiet session, for tasks and folders', async () => {
    const { orch, tmux, clock, task, folderId, taskSession, folderSession } = await withSessions()
    tmux.activity.set(taskSession, secondsAgo(clock, 30))
    tmux.activity.set(folderSession, secondsAgo(clock, 30))
    tmux.panes.set(taskSession, PROMPT)
    tmux.panes.set(folderSession, INPUT)
    expect((await orch.getStatus()).activity).toEqual({ [task.id]: 'waiting', [folderId]: 'idle' })
    expect(tmux.captureCalls.sort()).toEqual([`${folderSession}:claude`, `${taskSession}:claude`])
  })

  it('captures a quiet screen again only after new activity', async () => {
    const { orch, tmux, clock, task, taskSession } = await withSessions()
    tmux.activity.set(taskSession, secondsAgo(clock, 30))
    tmux.panes.set(taskSession, PROMPT)
    await orch.getStatus()
    clock.now += 3000
    tmux.panes.set(taskSession, INPUT) // can't really change without activity; proves the cache is used
    expect((await orch.getStatus()).activity[task.id]).toBe('waiting')
    expect(tmux.captureCalls).toHaveLength(1)

    tmux.activity.set(taskSession, secondsAgo(clock, 5)) // the user answered; Claude printed, then went quiet
    expect((await orch.getStatus()).activity[task.id]).toBe('idle')
    expect(tmux.captureCalls).toHaveLength(2)
  })

  it('leaves out sessions without a claude window or not running, and treats a failed capture as idle', async () => {
    const { orch, tmux, clock, task, taskSession, folderSession } = await withSessions()
    tmux.sessions.get(folderSession)!.windows[0].name = 'shell' // claude window closed
    tmux.activity.set(folderSession, secondsAgo(clock, 1))
    tmux.activity.set(taskSession, secondsAgo(clock, 30)) // no pane text: capture fails
    expect((await orch.getStatus()).activity).toEqual({ [task.id]: 'idle' })
    tmux.sessions.delete(taskSession)
    expect((await orch.getStatus()).activity).toEqual({})
  })

  it('still reports sessions when the activity call fails', async () => {
    const { orch, tmux, task } = await withSessions()
    tmux.windowActivity = async () => Promise.reject(new Error('tmux died'))
    const status = await orch.getStatus()
    expect(status.running).toContain(task.id)
    expect(status.activity).toEqual({})
  })
})
