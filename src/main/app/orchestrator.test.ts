import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  claudePromptCommand,
  claudeMessage,
  MAX_RESOLVE_FILES,
  normalizeTaskOptions,
  promptArgument,
  resolvePrompt,
  RUN_RESTART_GRACE_MS,
  runWindowCommand,
  DEV_URL_RESCAN_MS,
  DEV_URL_SCROLLBACK_LINES,
} from './orchestrator'
import { GH_INSTALL_HINT } from '../../shared/git'
import {
  MAX_CLAUDE_MESSAGE,
  MAX_COMMIT_MESSAGE,
  MAX_TASK_PROMPT,
  MAX_TRANSCRIPT_BYTES,
  type AppState,
  type Target,
  type Task,
  type TaskGitStatus,
} from '../../shared/types'
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

/**
 * The words `command` (a claude command line) hands `claude`, run by sh with `promptFile` holding `content`.
 * printf stands in for claude.
 */
function claudeWords(command: (promptFile: string) => string, content: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'mm-prompt-'))
  try {
    const file = join(dir, "it's a prompt.txt")
    writeFileSync(file, content)
    const script = `claude() { printf '%s\\0' "$@"; }; ${command(file)}`
    return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).split('\0').slice(0, -1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

describe('Orchestrator: undoing a removal', () => {
  it('restores a removed repo as it was and saves it', async () => {
    const { orch, store, themeId, repoId } = await setup()
    const before = await orch.getState()
    const repo = before.themes[0].items[0]
    await orch.removeItem(themeId, repoId)
    const restored = await orch.restoreItem(themeId, repo, 0)
    expect(restored).toEqual(before)
    expect(store.saved.at(-1)).toEqual(before)
    expect(await orch.getState()).toEqual(before)
  })
  it('restores a removed folder without restarting its session', async () => {
    const { orch, tmux, themeId } = await setup()
    const s = await orch.addFolder(themeId, '/docs/notes')
    const folder = s.themes[0].items[1]
    await orch.openTarget({ themeId, itemId: folder.id })
    await orch.removeItem(themeId, folder.id)
    tmux.calls = []
    const restored = await orch.restoreItem(themeId, folder, 1)
    expect(restored.themes[0].items[1]).toEqual(folder)
    expect(tmux.calls).toEqual([])
  })
  it('refuses a restore that collides, without saving', async () => {
    const { orch, store, themeId, repoId } = await setup()
    const repo = (await orch.getState()).themes[0].items[0]
    await orch.removeItem(themeId, repoId)
    await orch.addRepo(themeId, '/code/my-api/src') // the same path again, with a new id
    const saves = store.saved.length
    await expect(orch.restoreItem(themeId, repo)).rejects.toThrow('/code/my-api is already in this theme')
    expect(store.saved.length).toBe(saves)
  })
  it('restores a removed theme with its items at its old position', async () => {
    const { orch, themeId } = await setup()
    await orch.addFolder(themeId, '/docs/notes')
    const before = await orch.createTheme('Personal')
    await orch.removeTheme(themeId)
    const restored = await orch.restoreTheme(before.themes[0], 0)
    expect(restored).toEqual(before)
  })
  it('refuses to restore a theme whose name was taken meanwhile', async () => {
    const { orch, themeId } = await setup()
    const theme = (await orch.getState()).themes[0]
    await orch.removeTheme(themeId)
    await orch.createTheme('Client X')
    await expect(orch.restoreTheme(theme)).rejects.toThrow(/already exists/)
    expect((await orch.getState()).themes).toHaveLength(1)
  })
})

describe('Orchestrator: reordering', () => {
  /** Themes Client X (my-api with tasks one, two, three, and the folder notes), Personal and Work. */
  async function withOrder(): Promise<Ctx & { folderId: string; taskIds: string[] }> {
    const ctx = await setup()
    const { orch, themeId, repoId } = ctx
    for (const name of ['one', 'two', 'three']) await orch.createTask(themeId, repoId, name)
    await orch.addFolder(themeId, '/docs/notes')
    await orch.createTheme('Personal')
    const s = await orch.createTheme('Work')
    const [repo, folder] = s.themes[0].items
    return { ...ctx, folderId: folder.id, taskIds: repo.kind === 'repo' ? repo.tasks.map((t) => t.id) : [] }
  }
  const themeNames = (s: AppState): string[] => s.themes.map((t) => t.name)
  const itemNames = (s: AppState): string[] => s.themes[0].items.map((i) => i.name)
  const taskNames = (s: AppState): string[] => {
    const repo = s.themes.flatMap((t) => t.items).find((i) => i.name === 'my-api')
    return repo?.kind === 'repo' ? repo.tasks.map((t) => t.name) : []
  }

  it('moves themes, items and tasks, saving each move and touching neither git nor tmux', async () => {
    const { orch, store, git, tmux, themeId, repoId, folderId, taskIds } = await withOrder()
    git.calls = []
    tmux.calls = []
    const saves = store.saved.length
    expect(themeNames(await orch.moveTheme(themeId, 2))).toEqual(['Personal', 'Work', 'Client X'])
    await orch.moveTheme(themeId, 0)
    expect(itemNames(await orch.moveItem(themeId, folderId, 0))).toEqual(['notes', 'my-api'])
    const moved = await orch.moveTask(themeId, repoId, taskIds[2], 0)
    expect(taskNames(moved)).toEqual(['three', 'one', 'two'])
    expect(store.saved).toHaveLength(saves + 4)
    expect(store.saved.at(-1)).toEqual(moved)
    expect(await orch.getState()).toEqual(moved)
    expect(git.calls).toEqual([])
    expect(tmux.calls).toEqual([])
  })

  it('clamps the index', async () => {
    const { orch, themeId, repoId, folderId, taskIds } = await withOrder()
    expect(themeNames(await orch.moveTheme(themeId, 99))).toEqual(['Personal', 'Work', 'Client X'])
    expect(themeNames(await orch.moveTheme(themeId, -5))).toEqual(['Client X', 'Personal', 'Work'])
    expect(itemNames(await orch.moveItem(themeId, folderId, -1))).toEqual(['notes', 'my-api'])
    expect(taskNames(await orch.moveTask(themeId, repoId, taskIds[0], 10))).toEqual(['two', 'three', 'one'])
  })

  it('does not save when nothing moves', async () => {
    const { orch, store, themeId, repoId, folderId, taskIds } = await withOrder()
    const before = await orch.getState()
    const saves = store.saved.length
    expect(await orch.moveTheme(themeId, 0)).toBe(before)
    expect(await orch.moveTheme(themeId, -3)).toBe(before)
    expect(await orch.moveItem(themeId, folderId, 1)).toBe(before)
    expect(await orch.moveItem(themeId, folderId, 8)).toBe(before)
    expect(await orch.moveTask(themeId, repoId, taskIds[1], 1)).toBe(before)
    expect(store.saved).toHaveLength(saves)
  })

  it('rejects unknown ids, an archived task, a folder as the repo and a bad position, without saving', async () => {
    const { orch, store, themeId, repoId, folderId, taskIds } = await withOrder()
    await orch.archiveTask(themeId, repoId, taskIds[1])
    const otherTheme = (await orch.getState()).themes[1].id
    const saves = store.saved.length
    await expect(orch.moveTheme('nope', 0)).rejects.toThrow('Theme not found: nope')
    await expect(orch.moveItem(themeId, 'nope', 0)).rejects.toThrow('Item not found: nope')
    await expect(orch.moveItem(otherTheme, folderId, 0)).rejects.toThrow(`Item not found: ${folderId}`)
    await expect(orch.moveTask(themeId, repoId, 'nope', 0)).rejects.toThrow('Task not found: nope')
    await expect(orch.moveTask(themeId, folderId, taskIds[0], 0)).rejects.toThrow('"notes" is not a repository')
    await expect(orch.moveTask(themeId, repoId, taskIds[1], 0)).rejects.toThrow('"two" is archived: restore it first')
    await expect(orch.moveTheme(themeId, '1' as unknown as number)).rejects.toThrow('Invalid position to move to')
    expect(store.saved).toHaveLength(saves)
  })

  it('keeps the order across a restart', async () => {
    const ctx = await withOrder()
    const { orch, themeId, repoId, folderId, taskIds } = ctx
    await orch.moveTheme(themeId, 1)
    await orch.moveItem(themeId, folderId, 0)
    await orch.moveTask(themeId, repoId, taskIds[0], 2)
    const reloaded = new Orchestrator(ctx.deps)
    await reloaded.init()
    const s = await reloaded.getState()
    expect(themeNames(s)).toEqual(['Personal', 'Client X', 'Work'])
    expect(s.themes[1].items.map((i) => i.name)).toEqual(['notes', 'my-api'])
    expect(taskNames(s)).toEqual(['two', 'three', 'one'])
  })

  it('queues a move behind the state changes before it', async () => {
    const { orch, themeId } = await withOrder()
    const renamed = orch.renameTheme(themeId, 'Clients')
    const moved = orch.moveTheme(themeId, 2)
    await renamed
    expect(themeNames(await moved)).toEqual(['Personal', 'Work', 'Clients'])
  })
})

describe('Orchestrator: cloneRepo', () => {
  /** A theme "Client X"; only the folders in `existing` exist on disk. */
  async function cloneSetup(): Promise<
    ReturnType<typeof makeDeps> & { orch: Orchestrator; themeId: string; existing: Set<string> }
  > {
    const existing = new Set(['/code'])
    const ctx = makeDeps({ pathExists: (p) => existing.has(p) })
    const orch = new Orchestrator(ctx.deps)
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    return { ...ctx, orch, themeId, existing }
  }
  const URL = 'git@github.com:acme/my-api.git'

  it('clones into <parent>/<name>, adds the repo and remembers the parent folder', async () => {
    const { orch, git, settings, themeId } = await cloneSetup()
    const s = await orch.cloneRepo(themeId, ` ${URL} `, '/code', ' my-api ')
    expect(git.calls).toEqual([`clone ${URL} /code/my-api`])
    expect(s.themes[0].items[0]).toMatchObject({ kind: 'repo', name: 'my-api', path: '/code/my-api', tasks: [] })
    expect(settings.get().cloneDirectory).toBe('/code')
  })

  it('checks the URL, name and folders before running git', async () => {
    const { orch, git, existing, themeId } = await cloneSetup()
    await expect(orch.cloneRepo(themeId, '-u touch /tmp/x', '/code', 'x')).rejects.toThrow(/start with “-”/)
    await expect(orch.cloneRepo(themeId, 'ext::sh', '/code', 'x')).rejects.toThrow(/ext::/)
    await expect(orch.cloneRepo(themeId, URL, '/code', '../x')).rejects.toThrow(/“\/”/)
    await expect(orch.cloneRepo(themeId, URL, '/code', '..')).rejects.toThrow(/another folder name/)
    await expect(orch.cloneRepo(themeId, URL, 'code', 'x')).rejects.toThrow('Choose the folder to clone into')
    await expect(orch.cloneRepo(themeId, URL, '/nope', 'x')).rejects.toThrow('Folder not found: /nope')
    existing.add('/code/my-api')
    await expect(orch.cloneRepo(themeId, URL, '/code', 'my-api')).rejects.toThrow('/code/my-api already exists')
    await expect(orch.cloneRepo('nope', URL, '/code', 'x')).rejects.toThrow(/Theme not found/)
    expect(git.calls).toEqual([])
  })

  it('refuses a name the theme already has before cloning', async () => {
    const { orch, git, themeId } = await cloneSetup()
    await orch.addFolder(themeId, '/docs/my-api')
    await expect(orch.cloneRepo(themeId, URL, '/code', 'my-api')).rejects.toThrow(/already exists in this theme/)
    expect(git.calls).toEqual([])
  })

  it("adds nothing and keeps the settings when git fails, with git's error", async () => {
    const { orch, git, store, settings, themeId } = await cloneSetup()
    git.failClone = 'git clone failed: fatal: repository not found'
    const saves = store.saved.length
    await expect(orch.cloneRepo(themeId, URL, '/code', 'my-api')).rejects.toThrow('fatal: repository not found')
    expect(store.saved.length).toBe(saves)
    expect((await orch.getState()).themes[0].items).toEqual([])
    expect(settings.get().cloneDirectory).toBe('')
  })

  it("doesn't hold up other changes while cloning, and reports a theme removed meanwhile", async () => {
    const { orch, git, themeId } = await cloneSetup()
    let release = (): void => {}
    git.cloneGate = new Promise((r) => (release = r))
    const cloning = orch.cloneRepo(themeId, URL, '/code', 'my-api')
    await orch.createTheme('Other') // not queued behind the clone
    await orch.removeTheme(themeId)
    release()
    await expect(cloning).rejects.toThrow(/^Cloned into \/code\/my-api, but could not add it: Theme not found/)
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
  it("replaces a leftover session with the new task's name (from a crash), starting Claude in the new worktree", async () => {
    const { orch, tmux, themeId, repoId } = await setup()
    await tmux.newSession('mmt_client-x_my-api_fix', '/wt/client-x/my-api/fix', 'claude', 'claude --continue')
    tmux.calls = []
    await orch.createTask(themeId, repoId, 'fix')
    expect(tmux.calls).toEqual([
      'killSession mmt_client-x_my-api_fix',
      `newSession mmt_client-x_my-api_fix ${CLAUDE_CMD}`,
    ])
    expect(tmux.sessions.get('mmt_client-x_my-api_fix')?.windows).toEqual([{ name: 'claude', command: CLAUDE_CMD }])
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

describe('Orchestrator: new-task options', () => {
  it('lists the branches after a fetch, the default first', async () => {
    const { orch, git, themeId, repoId } = await setup()
    git.calls = []
    await expect(orch.listBranches(themeId, repoId)).resolves.toEqual({
      default: 'origin/main',
      branches: ['origin/main', 'origin/develop', 'main'],
    })
    expect(git.calls).toEqual(['fetch /code/my-api', 'listBranches /code/my-api'])
  })

  it('still lists the branches when the fetch fails, and adds a default git did not list', async () => {
    const { orch, git, themeId, repoId } = await setup()
    git.failFetch = true
    git.branches = ['origin/develop']
    await expect(orch.listBranches(themeId, repoId)).resolves.toEqual({
      default: 'origin/main',
      branches: ['origin/main', 'origin/develop'],
    })
  })

  it('lists the branches, the first as the default, when the repo has no default base (a detached HEAD)', async () => {
    const { orch, git, themeId, repoId } = await setup()
    git.noDefaultBase = 'Could not find a base branch in /code/my-api'
    git.branches = ['develop', 'trunk']
    await expect(orch.listBranches(themeId, repoId)).resolves.toEqual({
      default: 'develop',
      branches: ['develop', 'trunk'],
    })
    expect(taskOf(await orch.createTask(themeId, repoId, 'fix', { baseRef: 'trunk' })).baseRef).toBe('trunk')
    await expect(orch.createTask(themeId, repoId, 'other')).rejects.toThrow('Could not find a base branch')
    git.branches = []
    await expect(orch.listBranches(themeId, repoId)).rejects.toThrow('Could not find a base branch')
  })

  it('says the repository is gone, before running git, when its folder was moved or deleted', async () => {
    const { orch, git, deps, themeId, repoId } = await setup()
    deps.pathExists = (path) => path !== '/code/my-api'
    git.calls = []
    await expect(orch.listBranches(themeId, repoId)).rejects.toThrow('Repository not found: /code/my-api')
    await expect(orch.createTask(themeId, repoId, 'fix')).rejects.toThrow('Repository not found: /code/my-api')
    expect(git.calls).toEqual([])
  })

  it('creates the worktree from the chosen base branch and records it', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix', { baseRef: 'origin/develop' }))
    expect(task.baseRef).toBe('origin/develop')
    expect(git.calls).toContain('addWorktree /wt/client-x/my-api/fix claude/client-x/fix origin/develop')
  })

  it('uses the default base when none is chosen', async () => {
    const { orch, themeId, repoId } = await setup()
    expect(taskOf(await orch.createTask(themeId, repoId, 'fix', { baseRef: ' ' })).baseRef).toBe('origin/main')
  })

  it('refuses an unlisted, unresolvable or option-like base branch before creating anything', async () => {
    const { orch, git, tmux, store, themeId, repoId } = await setup()
    git.unresolvable.add('main')
    const saves = store.saved.length
    await expect(orch.createTask(themeId, repoId, 'a', { baseRef: 'origin/nope' })).rejects.toThrow(
      'Unknown base branch: origin/nope',
    )
    await expect(orch.createTask(themeId, repoId, 'a', { baseRef: '--upload-pack=evil' })).rejects.toThrow(
      'Invalid base branch',
    )
    await expect(orch.createTask(themeId, repoId, 'a', { baseRef: 'main' })).rejects.toThrow(
      'Base branch not found: main',
    )
    expect(git.calls.some((c) => c.startsWith('addWorktree'))).toBe(false)
    expect(tmux.calls).toEqual([])
    expect(store.saved.length).toBe(saves)
  })

  it('passes the initial prompt through a private file, on the first start only', async () => {
    const { orch, tmux, promptFiles, themeId, repoId } = await setup()
    await orch.updateSettings({ claudeArgs: ['--model', 'opus'] })
    const prompt = "Fix the login bug; don't touch $(rm -rf ~) or `id`\nthen run the tests"
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix', { prompt: `  ${prompt}  ` }))
    const file = '/prompts/prompt-1.txt'
    expect(tmux.calls).toEqual([`newSession mmt_client-x_my-api_fix claude --model opus -- "$(cat -- ${file})"`])
    expect(promptFiles.written.get(file)).toBe(`${prompt} `)
    // Released after the start, to be removed once the shell had time to read it.
    expect(promptFiles.calls).toEqual([`write ${file}`, `release ${file}`])

    // A recreated session and a restarted Claude window continue the conversation instead.
    const target = { themeId, itemId: repoId, taskId: task.id }
    tmux.sessions.clear()
    await orch.openTarget(target)
    await orch.newTab(target)
    await orch.closeTab(target, 0)
    await orch.restartClaude(target)
    const later = [tmux.calls.at(-1), tmux.sessions.get('mmt_client-x_my-api_fix')?.windows.at(-1)?.command]
    for (const command of later) {
      expect(command).toContain('claude --model opus --continue || claude --model opus')
      expect(command).not.toContain('Fix the login bug')
    }
  })

  it('keeps $(…), quotes and long text in the prompt file literal for the shell', () => {
    // The shell must hand the file's text to claude verbatim, as one argument, never running or splitting it.
    for (const prompt of [
      `$(touch /tmp/mm-pwned) \`id\` 'single' "double" $HOME ; & | --flag * ~ \\n`,
      `${'é'.repeat(10_000)} `,
      "'".repeat(10_000),
      'two\nlines\n\n ',
    ]) {
      const words = claudeWords((file) => claudePromptCommand(['--model', 'opus'], file), prompt)
      expect(words).toEqual(['--model', 'opus', '--', prompt])
    }
    expect(claudePromptCommand([], undefined)).toBe('claude')
  })

  it('removes the prompt file right away when tmux fails, and writes none without a prompt', async () => {
    const { orch, tmux, promptFiles, themeId, repoId } = await setup()
    tmux.failNewSession = true
    await expect(orch.createTask(themeId, repoId, 'fix', { prompt: 'hi there' })).rejects.toThrow('tmux failed')
    expect(promptFiles.calls).toEqual(['write /prompts/prompt-1.txt', 'release /prompts/prompt-1.txt now'])
    tmux.failNewSession = false
    promptFiles.calls = []
    await orch.createTask(themeId, repoId, 'fix')
    expect(promptFiles.calls).toEqual([])
  })

  it('never hands Claude a one-word prompt it would read as a subcommand', () => {
    // `claude -- mcp` runs `claude mcp`, and a word close to a subcommand (`mcpx`) fails as an unknown command:
    // Claude only reads its lone positional argument as a prompt when it is more than one word.
    for (const prompt of ['mcp', 'purge', 'doctor', 'mcpx', 'hello']) {
      // The trailing space survives the shell's `$(…)`, which only drops trailing newlines.
      const [dashDash, arg, ...rest] = claudeWords((file) => claudePromptCommand([], file), promptArgument(prompt))
      expect([dashDash, rest]).toEqual(['--', []])
      expect(arg).not.toBe(prompt)
      expect(arg).toMatch(/\s/)
      expect(arg.trim()).toBe(prompt)
    }
  })

  it('validates the options it gets over IPC', () => {
    expect(normalizeTaskOptions(undefined)).toEqual({})
    expect(normalizeTaskOptions({ baseRef: ' origin/x ', prompt: '  hi  ' })).toEqual({
      baseRef: 'origin/x',
      prompt: 'hi',
    })
    expect(normalizeTaskOptions({ baseRef: '', prompt: '   ' })).toEqual({})
    expect(normalizeTaskOptions({ prompt: 'x'.repeat(MAX_TASK_PROMPT) }).prompt).toHaveLength(MAX_TASK_PROMPT)
    expect(() => normalizeTaskOptions({ prompt: 'x'.repeat(MAX_TASK_PROMPT + 1) })).toThrow(
      'The initial prompt is limited to 10,000 characters',
    )
    expect(() => normalizeTaskOptions({ prompt: 42 })).toThrow('Invalid initial prompt')
    expect(() => normalizeTaskOptions({ baseRef: 'a\0b' })).toThrow('Invalid base branch')
    expect(() => normalizeTaskOptions('origin/main')).toThrow('Invalid task options')
  })

  it('rejects a too-long prompt before touching git', async () => {
    const { orch, git, themeId, repoId } = await setup()
    git.calls = []
    await expect(orch.createTask(themeId, repoId, 'fix', { prompt: 'x'.repeat(MAX_TASK_PROMPT + 1) })).rejects.toThrow(
      /limited to/,
    )
    expect(git.calls).toEqual([])
  })
})

describe('Orchestrator: theme style', () => {
  it('sets a theme colour and icon and saves, touching neither git nor tmux', async () => {
    const { orch, store, git, tmux, themeId } = await setup()
    git.calls = []
    tmux.calls = []
    const s = await orch.customizeTheme(themeId, { color: 'teal', icon: '🧪' })
    expect(s.themes[0]).toMatchObject({ name: 'Client X', slug: 'client-x', color: 'teal', icon: '🧪' })
    expect(store.saved.at(-1)).toEqual(s)
    expect(await orch.getState()).toBe(s)
    expect(git.calls).toEqual([])
    expect(tmux.calls).toEqual([])
    const cleared = await orch.customizeTheme(themeId, {})
    expect(cleared.themes[0]).not.toHaveProperty('color')
    expect(cleared.themes[0]).not.toHaveProperty('icon')
  })

  it('rejects an invalid style without saving', async () => {
    const { orch, store, themeId } = await setup()
    const saves = store.saved.length
    await expect(orch.customizeTheme(themeId, { color: 'url(x)' as never })).rejects.toThrow(/Unknown theme colour/)
    await expect(orch.customizeTheme(themeId, { icon: 'abc' })).rejects.toThrow('Use a single emoji')
    expect(store.saved.length).toBe(saves)
    expect((await orch.getState()).themes[0]).not.toHaveProperty('color')
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

describe('Orchestrator: task budgets', () => {
  it("saves a task's own budget and clears it with null, touching neither git nor tmux", async () => {
    const { orch, store, git, tmux, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    git.calls = []
    tmux.calls = []
    let s = await orch.setTaskBudget(themeId, repoId, task.id, 7.5)
    expect(taskOf(s).budgetUsd).toBe(7.5)
    expect(store.saved.at(-1)).toEqual(s)
    s = await orch.setTaskBudget(themeId, repoId, task.id, null)
    expect(taskOf(s)).toEqual(task)
    expect(git.calls).toEqual([])
    expect(tmux.calls).toEqual([])
  })

  it('rejects an invalid budget without saving', async () => {
    const { orch, store, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    const saves = store.saved.length
    await expect(orch.setTaskBudget(themeId, repoId, task.id, -1)).rejects.toThrow(/The budget must be an amount/)
    expect(store.saved.length).toBe(saves)
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

describe('Orchestrator: archiving tasks', () => {
  const WT = '/wt/client-x/my-api/fix'
  const BRANCH = 'claude/client-x/fix'
  const SESSION = 'mmt_client-x_my-api_fix'

  async function withTask(): Promise<Ctx & { clock: { now: number }; target: Target; task: Task }> {
    const ctx = makeDeps()
    ctx.git.roots.set('/code/my-api', '/code/my-api')
    const clock = { now: Date.parse('2026-02-01T10:00:00.000Z') }
    const orch = new Orchestrator(ctx.deps, { now: () => clock.now })
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    const repoId = (await orch.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const task = taskOf(
      await orch.setTaskNotes(themeId, repoId, taskOf(await orch.createTask(themeId, repoId, 'fix')).id, 'wip'),
    )
    const target = { themeId, itemId: repoId, taskId: task.id }
    await orch.openTarget(target)
    ctx.git.calls = []
    ctx.tmux.calls = []
    return { ...ctx, orch, themeId, repoId, clock, target, task }
  }

  /** withTask, archived, with the worktree folder gone as archiving leaves it. */
  async function withArchived(): Promise<Awaited<ReturnType<typeof withTask>>> {
    const ctx = await withTask()
    await ctx.orch.archiveTask(ctx.themeId, ctx.repoId, ctx.task.id)
    ctx.deps.pathExists = (p) => p !== WT
    ctx.git.calls = []
    ctx.tmux.calls = []
    return ctx
  }

  it('kills the session, detaches, removes the worktree and keeps the task with its branch, base and notes', async () => {
    const { orch, git, tmux, pty, store, themeId, repoId, task } = await withTask()
    const s = await orch.archiveTask(themeId, repoId, task.id)
    expect(pty.attached).toBeNull()
    expect(tmux.sessions.has(SESSION)).toBe(false)
    expect(git.calls).toEqual([`getUnsavedWork ${WT}`, `removeWorktree ${WT}`])
    expect(git.calls.some((c) => c.startsWith('deleteBranch'))).toBe(false)
    expect(taskOf(s)).toEqual({ ...task, archivedAt: '2026-02-01T10:00:00.000Z' })
    expect(taskOf(s).notes).toBe('wip')
    expect(store.saved.at(-1)).toEqual(s)
    expect(orch.currentTarget()).toBeNull()
  })

  it('refuses a worktree with uncommitted or untracked files, touching nothing', async () => {
    const { orch, git, tmux, store, themeId, repoId, task } = await withTask()
    git.unsaved = { uncommittedFiles: ['src/a.ts', 'new.txt'], unpushedCommits: [] }
    const saves = store.saved.length
    await expect(orch.archiveTask(themeId, repoId, task.id)).rejects.toThrow(
      '"fix" has 2 uncommitted or untracked files. Commit or discard the changes first',
    )
    expect(git.calls).toEqual([`getUnsavedWork ${WT}`])
    expect(tmux.sessions.has(SESSION)).toBe(true)
    expect(store.saved).toHaveLength(saves)
    expect(taskOf(await orch.getState()).archivedAt).toBeUndefined()
  })

  it('refuses when the worktree could not be checked, saying why', async () => {
    const { orch, git, themeId, repoId, task } = await withTask()
    git.unsaved = { uncommittedFiles: [], unpushedCommits: [], warning: `git status failed in ${WT}.` }
    await expect(orch.archiveTask(themeId, repoId, task.id)).rejects.toThrow(
      `git status failed in ${WT}. Commit or discard the changes first`,
    )
  })

  it('archives anyway with force, without checking, discarding the changes', async () => {
    const { orch, git, themeId, repoId, task } = await withTask()
    git.unsaved = { uncommittedFiles: ['src/a.ts'], unpushedCommits: [] }
    const s = await orch.archiveTask(themeId, repoId, task.id, true)
    expect(git.calls).toEqual([`removeWorktree ${WT}`])
    expect(taskOf(s).archivedAt).toBe('2026-02-01T10:00:00.000Z')
  })

  it('does not count unpushed commits against archiving: the branch keeps them', async () => {
    const { orch, git, themeId, repoId, task } = await withTask()
    git.unsaved = { uncommittedFiles: [], unpushedCommits: ['abc1234 wip'] }
    await expect(orch.archiveTask(themeId, repoId, task.id)).resolves.toBeDefined()
  })

  it('refuses when the original repository is gone, since its branch went with it', async () => {
    const { orch, git, deps, themeId, repoId, task } = await withTask()
    deps.pathExists = (p) => p !== '/code/my-api'
    await expect(orch.archiveTask(themeId, repoId, task.id, true)).rejects.toThrow(
      "The repository was not found at /code/my-api, so the branch can't be kept: remove the task instead",
    )
    expect(git.calls).toEqual([])
  })

  it('refuses to archive a task twice', async () => {
    const { orch, git, themeId, repoId, task } = await withArchived()
    await expect(orch.archiveTask(themeId, repoId, task.id, true)).rejects.toThrow('"fix" is already archived')
    expect(git.calls).toEqual([])
  })

  it('archives only after the git action running on the task', async () => {
    const { orch, git, themeId, repoId, target, task } = await withTask()
    let release = (): void => {}
    git.actionGate = new Promise<void>((r) => (release = r))
    const push = orch.pushTask(target)
    const archive = orch.archiveTask(themeId, repoId, task.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(git.calls).toEqual([`push ${WT} ${BRANCH}`])
    release()
    await Promise.all([push, archive])
    expect(git.calls.at(-1)).toBe(`removeWorktree ${WT}`)
  })

  it('refuses to open a task while it is being archived or removed, leaving no session behind', async () => {
    for (const close of ['archive', 'remove'] as const) {
      const { orch, git, tmux, pty, themeId, repoId, target, task } = await withTask()
      let release = (): void => {}
      const gate = new Promise<void>((r) => (release = r))
      const removeWorktree = git.removeWorktree.bind(git)
      git.removeWorktree = async (repo: string, wt: string): Promise<void> => {
        await gate // a big worktree takes a while to delete
        return removeWorktree(repo, wt)
      }
      const closing =
        close === 'archive'
          ? orch.archiveTask(themeId, repoId, task.id)
          : orch.removeTask(themeId, repoId, task.id, false)
      await new Promise((r) => setTimeout(r, 0))
      expect(tmux.sessions.has(SESSION)).toBe(false)
      await expect(orch.openTarget(target)).rejects.toThrow(
        `"fix" is being ${close === 'archive' ? 'archived' : 'removed'}`,
      )
      release()
      await closing
      expect(tmux.sessions.has(SESSION)).toBe(false)
      expect(pty.attached).toBeNull()
      expect(orch.currentTarget()).toBeNull()
    }
  })

  it('kills the session an open started while the task was archived, and does not attach', async () => {
    const { orch, tmux, pty, themeId, repoId, target, task } = await withTask()
    await orch.detachTerminal()
    tmux.sessions.clear()
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const hasSession = tmux.hasSession.bind(tmux)
    tmux.hasSession = async (name: string): Promise<boolean> => {
      await gate // tmux is slow to answer
      return hasSession(name)
    }
    const opening = orch.openTarget(target)
    const archiving = orch.archiveTask(themeId, repoId, task.id)
    release()
    await archiving
    await expect(opening).rejects.toThrow(/"fix" is (being )?archived/)
    expect(tmux.sessions.has(SESSION)).toBe(false)
    expect(pty.attached).toBeNull()
    expect(orch.currentTarget()).toBeNull()
  })

  it('waits for the git action on the task without holding up changes elsewhere', async () => {
    for (const close of ['archive', 'remove'] as const) {
      const { orch, git, themeId, repoId, target, task } = await withTask()
      let release = (): void => {}
      git.actionGate = new Promise<void>((r) => (release = r))
      const push = orch.pushTask(target) // a slow network
      const closing =
        close === 'archive'
          ? orch.archiveTask(themeId, repoId, task.id)
          : orch.removeTask(themeId, repoId, task.id, false)
      let renamed = false
      void orch.renameTheme(themeId, 'Client Y').then(() => (renamed = true))
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
      expect(renamed).toBe(true)
      expect(git.calls).toEqual([`push ${WT} ${BRANCH}`])
      release()
      await Promise.all([push, closing])
      expect(git.calls.at(-1)).toBe(`removeWorktree ${WT}`)
    }
  })

  it('runs concurrent archive and restore calls one at a time, so only one archive takes effect', async () => {
    const { orch, git, themeId, repoId, task } = await withTask()
    const results = await Promise.allSettled([
      orch.archiveTask(themeId, repoId, task.id),
      orch.archiveTask(themeId, repoId, task.id),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(git.calls.filter((c) => c.startsWith('removeWorktree'))).toHaveLength(1)
  })

  it('restores the worktree from the kept branch, without starting a session, then opens it lazily', async () => {
    const { orch, git, tmux, store, deps, themeId, repoId, target, task } = await withArchived()
    const s = await orch.unarchiveTask(themeId, repoId, task.id)
    expect(git.calls).toEqual([`restoreWorktree ${WT} ${BRANCH}`])
    expect(git.calls.some((c) => c.startsWith('addWorktree'))).toBe(false)
    expect(taskOf(s)).toEqual(task)
    expect(store.saved.at(-1)).toEqual(s)
    expect(tmux.calls).toEqual([])
    deps.pathExists = () => true
    await orch.openTarget(target)
    expect(tmux.calls).toEqual([`newSession ${SESSION} ${CLAUDE_CONTINUE_CMD}`])
  })

  it('refuses to restore when the branch no longer exists, keeping the task archived', async () => {
    const { orch, git, store, themeId, repoId, task } = await withArchived()
    git.failRestore = `The branch "${BRANCH}" no longer exists, so the task can't be restored`
    const saves = store.saved.length
    await expect(orch.unarchiveTask(themeId, repoId, task.id)).rejects.toThrow(git.failRestore)
    expect(store.saved).toHaveLength(saves)
    expect(taskOf(await orch.getState()).archivedAt).toBeDefined()
  })

  it('refuses to restore onto a taken path, or an active task, or when the repository is gone', async () => {
    const { orch, git, deps, themeId, repoId, task } = await withArchived()
    deps.pathExists = () => true
    await expect(orch.unarchiveTask(themeId, repoId, task.id)).rejects.toThrow(
      `${WT} is already taken; move it away, then restore the task`,
    )
    deps.pathExists = (p) => p !== WT && p !== '/code/my-api'
    await expect(orch.unarchiveTask(themeId, repoId, task.id)).rejects.toThrow('Repository not found: /code/my-api')
    expect(git.calls).toEqual([])
    deps.pathExists = (p) => p !== WT
    await orch.unarchiveTask(themeId, repoId, task.id)
    await expect(orch.unarchiveTask(themeId, repoId, task.id)).rejects.toThrow('"fix" is not archived')
  })

  it('deletes an archived task with its branch, without touching its (gone) worktree or session', async () => {
    const { orch, git, tmux, themeId, repoId, task } = await withArchived()
    git.unsaved = { uncommittedFiles: [], unpushedCommits: ['abc1234 wip'] }
    await expect(orch.checkTaskRemoval(themeId, repoId, task.id)).resolves.toEqual(git.unsaved)
    git.calls = []
    const s = await orch.removeTask(themeId, repoId, task.id, true)
    expect(git.calls).toEqual([`deleteBranch ${BRANCH}`])
    expect(tmux.calls).toEqual([])
    expect(taskOf(s)).toBeUndefined()
  })

  it('leaves archived tasks out of the status, activity and git status polls', async () => {
    const { orch, git, tmux, themeId, repoId, target, task } = await withArchived()
    // Even a session left over under the task's name (started by hand) is not reported.
    await tmux.newSession(SESSION, WT, 'claude', 'claude')
    tmux.activity.set(SESSION, 1_700_000_000)
    expect(await orch.getStatus()).toEqual({ running: [], missing: [], activity: {} })
    expect(tmux.captureCalls).toEqual([])
    git.statuses.set(WT, { ahead: 0, behind: 0, uncommitted: 0, branch: BRANCH })
    expect(await orch.getGitStatus([target])).toEqual({})
    expect(git.statusCalls).toEqual([])
    // An active task next to it still is.
    const repo = (await orch.createTask(themeId, repoId, 'other')).themes[0].items[0]
    const other = repo.kind === 'repo' ? repo.tasks.find((t) => t.id !== task.id) : undefined
    expect((await orch.getStatus()).running).toEqual([other?.id])
  })

  it('refuses to open, attach, or run tab, file, git or editor actions on an archived task', async () => {
    const { orch, tmux, pty, files, launcher, git, target } = await withArchived()
    const refusal = '"fix" is archived: restore it first'
    for (const call of [
      () => orch.openTarget(target),
      () => orch.listTabs(target),
      () => orch.newTab(target),
      () => orch.selectTab(target, 0),
      () => orch.closeTab(target, 0),
      () => orch.restartClaude(target),
      () => orch.leaveCopyMode(target),
      () => orch.askClaudeToResolve(target, 'rebase', ['a.ts']),
      () => orch.copyTranscript(target, 0),
      () => orch.captureTranscript(target, 0),
      () => orch.listFiles(target),
      () => orch.readFile(target, 'a.ts'),
      () => orch.searchFiles(target, 'x'),
      () => orch.listChanges(target),
      () => orch.fileDiff(target, 'a.ts'),
      () => orch.openInEditor(target),
      () => orch.openInFileManager(target),
      () => orch.commitAll(target, 'msg'),
      () => orch.pushTask(target),
      () => orch.updateFromBase(target),
      () => orch.createPullRequest(target),
    ])
      await expect(call()).rejects.toThrow(refusal)
    expect(tmux.calls).toEqual([])
    expect(pty.attached).toBeNull()
    expect(files.calls).toEqual([])
    expect(launcher.calls).toEqual([])
    expect(git.calls).toEqual([])
  })

  it('keeps an archived task in the usage report, labelled, for its past cost', async () => {
    const { orch, usage } = await withArchived()
    const report = await orch.getUsageReport()
    expect(report.themes[0].targets.map((t) => t.label)).toEqual(['my-api › fix (archived)'])
    expect(usage.calls[0].roots).toEqual([WT])
  })

  it('keeps a removed repo and theme refused while an archived task remains', async () => {
    const { orch, themeId, repoId } = await withArchived()
    await expect(orch.removeItem(themeId, repoId)).rejects.toThrow('Remove the tasks in "my-api" first')
    await expect(orch.removeTheme(themeId)).rejects.toThrow('Remove the tasks in "Client X" first')
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

  it('starts the session once and attaches when the same target is opened twice at once', async () => {
    const { orch, tmux, pty, target } = await withTask()
    tmux.sessions.clear()
    const tabs = await Promise.all([orch.openTarget(target), orch.openTarget(target)])
    expect(tabs).toEqual([[{ index: 0, name: 'claude', active: true }], [{ index: 0, name: 'claude', active: true }]])
    expect(tmux.sessions.get('mmt_client-x_my-api_fix')?.windows).toHaveLength(1)
    expect(pty.attached?.args).toEqual(['attach', 'mmt_client-x_my-api_fix'])
    expect(orch.currentTarget()).toEqual(target)
  })

  it('detaches the terminal on request, cancelling an open still in flight', async () => {
    const { orch, tmux, pty, target } = await withTask()
    await orch.openTarget(target)
    await orch.detachTerminal()
    expect(pty.attached).toBeNull()
    expect(orch.currentTarget()).toBeNull()

    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const hasSession = tmux.hasSession.bind(tmux)
    tmux.hasSession = async (name: string): Promise<boolean> => {
      await gate
      return hasSession(name)
    }
    const opening = orch.openTarget(target)
    await orch.detachTerminal()
    release()
    await opening
    expect(pty.attached).toBeNull()
    expect(orch.currentTarget()).toBeNull()
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

describe('Orchestrator: transcripts', () => {
  async function withTabs(): Promise<Ctx & { target: Target; folder: Target }> {
    const ctx = makeDeps()
    ctx.git.roots.set('/code/my-api', '/code/my-api')
    // 9:05 local time, for the file name.
    const orch = new Orchestrator(ctx.deps, { now: () => new Date(2026, 9, 18, 9, 5, 30).getTime() })
    await orch.init()
    const themeId = (await orch.createTheme('Client X')).themes[0].id
    const repoId = (await orch.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    const target = { themeId, itemId: repoId, taskId: task.id }
    await orch.newTab(target) // index 1, "shell"
    const folderId = (await orch.addFolder(themeId, '/docs/notes')).themes[0].items[1].id
    const folder = { themeId, itemId: folderId }
    await orch.openTarget(folder)
    return { ...ctx, orch, themeId, repoId, target, folder }
  }

  it("copies a tab's scrollback by its index, with its line count", async () => {
    const { orch, tmux, target } = await withTabs()
    tmux.histories.set('mmt_client-x_my-api_fix:1', 'one\ntwo\nthree\n')
    await expect(orch.copyTranscript(target, 1)).resolves.toEqual({
      text: 'one\ntwo\nthree\n',
      lines: 3,
      truncated: false,
    })
    await expect(orch.copyTranscript(target, 0)).resolves.toEqual({ text: '', lines: 0, truncated: false })
    expect(tmux.historyCalls).toEqual(['mmt_client-x_my-api_fix:1', 'mmt_client-x_my-api_fix:0'])
  })

  it('caps the transcript at MAX_TRANSCRIPT_BYTES and says so', async () => {
    const { orch, tmux, target } = await withTabs()
    const line = `${'x'.repeat(1023)}\n`
    tmux.histories.set('mmt_client-x_my-api_fix:0', line.repeat(MAX_TRANSCRIPT_BYTES / 1024 + 10))
    const transcript = await orch.copyTranscript(target, 0)
    expect(transcript.truncated).toBe(true)
    expect(transcript.lines).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES / 1024)
    expect(transcript.text.length).toBe(transcript.lines * 1024)
  })

  it('names the file after the theme, the task or folder, the tab and the time', async () => {
    const { orch, tmux, target, folder } = await withTabs()
    tmux.histories.set('mmt_client-x_my-api_fix:1', 'hi\n')
    await expect(orch.captureTranscript(target, 1)).resolves.toEqual({
      transcript: { text: 'hi\n', lines: 1, truncated: false },
      fileName: 'client-x-fix-shell-20261018-0905.txt',
    })
    expect((await orch.captureTranscript(folder, 0)).fileName).toBe('client-x-notes-claude-20261018-0905.txt')
  })

  it("refuses a tab that is not one of the session's windows, before capturing anything", async () => {
    const { orch, tmux, target, folder } = await withTabs()
    for (const index of [2, -1, 1.5, Number.NaN, '1' as unknown as number, null as unknown as number]) {
      await expect(orch.copyTranscript(target, index)).rejects.toThrow(/tab/i)
    }
    tmux.sessions.delete('mmf_client-x_notes') // not running
    await expect(orch.copyTranscript(folder, 0)).rejects.toThrow(/tab/i)
    await expect(orch.copyTranscript({ ...target, taskId: 'nope' }, 0)).rejects.toThrow()
    expect(tmux.historyCalls).toEqual([])
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
    const { effective, ...saved } = next
    expect(settings.get()).toEqual(saved)
    expect(effective).toEqual({ remoteControl: false, skipPermissions: false })
    expect(await orch.getSettings()).toEqual(next)
  })

  it('says which built-in Claude flags apply, after the user arguments', async () => {
    const { orch, settings } = await setup()
    await orch.updateSettings({ remoteControl: true, skipPermissions: true })
    expect((await orch.getSettings()).effective).toEqual({ remoteControl: true, skipPermissions: true })
    const next = await orch.updateSettings({ claudeArgs: ['--permission-mode', 'acceptEdits'] })
    expect(next.effective).toEqual({ remoteControl: true, skipPermissions: false })
    // Never saved: it is worked out from the settings each time.
    expect(settings.get()).not.toHaveProperty('effective')
    await orch.updateSettings({ ...next, pollIntervalMs: 2000 })
    expect(settings.get()).not.toHaveProperty('effective')
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

describe('Orchestrator: quitting', () => {
  it('is idle at once when nothing runs', async () => {
    const { orch } = await setup()
    expect(orch.busy()).toBe(false)
    await orch.whenIdle(60_000)
  })

  it('waits for the changes running, and for ones queued while it waits', async () => {
    const { orch, store, themeId, repoId } = await setup()
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const save = store.save.bind(store)
    store.save = async (state: AppState): Promise<void> => {
      await gate // a slow disk
      return save(state)
    }
    const creating = orch.createTask(themeId, repoId, 'fix')
    await new Promise((r) => setTimeout(r, 0))
    expect(orch.busy()).toBe(true)
    let idle = false
    const waiting = orch.whenIdle(60_000).then(() => (idle = true))
    const renaming = orch.renameTheme(themeId, 'Client Y')
    await new Promise((r) => setTimeout(r, 0))
    expect(idle).toBe(false)
    release()
    await Promise.all([creating, renaming, waiting])
    expect(orch.busy()).toBe(false)
    expect(store.saved.at(-1)?.themes[0].name).toBe('Client Y')
  })

  it('gives up waiting after the time given', async () => {
    const { orch, store, themeId } = await setup()
    store.save = (): Promise<void> => new Promise(() => {}) // never finishes
    void orch.renameTheme(themeId, 'Client Y')
    const started = Date.now()
    await orch.whenIdle(50)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(orch.busy()).toBe(true)
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

  it('fetches outside the state queue, so a slow fetch holds up no other change', async () => {
    const { orch, git, themeId, repoId } = await setup()
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    git.fetch = async (repo: string): Promise<void> => {
      git.calls.push(`fetch ${repo}`)
      await gate
    }
    let created = false
    const creating = orch.createTask(themeId, repoId, 'fix').finally(() => (created = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(git.calls).toEqual(['fetch /code/my-api'])
    await orch.renameTheme(themeId, 'Client Y') // not queued behind the fetch
    await orch.createTheme('Other')
    expect(created).toBe(false)
    release()
    const task = taskOf(await creating)
    expect(task.branch).toBe('claude/client-x/fix') // the theme's slug stays as it was
    expect((await orch.getState()).themes.map((t) => t.name)).toEqual(['Client Y', 'Other'])
  })

  it('checks the task again after the fetch, against the state as it is then', async () => {
    const { orch, git, themeId, repoId } = await setup()
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    git.fetch = (): Promise<void> => gate
    const creating = orch.createTask(themeId, repoId, 'fix')
    await new Promise((r) => setTimeout(r, 0))
    await orch.removeItem(themeId, repoId)
    release()
    await expect(creating).rejects.toThrow(`Item not found: ${repoId}`)
    expect(git.calls.some((c) => c.startsWith('addWorktree'))).toBe(false)
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

  it('searches a task worktree with git and a folder by walking it, passing the query and options on', async () => {
    const { orch, files, taskTarget, folderTarget } = await withTaskAndFolder()
    files.searchFiles = async (root, isRepo, query, options) => {
      files.calls.push(`searchFiles ${root} ${isRepo} ${query} ${JSON.stringify(options ?? {})}`)
      return {
        matches: [{ path: 'a.ts', line: 2, column: 3, preview: 'x', matchStart: 0, matchLength: 1 }],
        truncated: true,
      }
    }
    await expect(orch.searchFiles(taskTarget, 'needle', { regex: true })).resolves.toEqual({
      matches: [{ path: 'a.ts', line: 2, column: 3, preview: 'x', matchStart: 0, matchLength: 1 }],
      truncated: true,
    })
    await orch.searchFiles(folderTarget, '--output=x')
    expect(files.calls).toEqual([
      'searchFiles /wt/client-x/my-api/fix true needle {"regex":true}',
      'searchFiles /docs/notes false --output=x {}',
    ])
  })

  it('cancels the search still running for a target when a newer one starts there', async () => {
    const { orch, files, taskTarget, folderTarget } = await withTaskAndFolder()
    const signals: AbortSignal[] = []
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    files.searchFiles = async (_root, _isRepo, query, _options, signal) => {
      signals.push(signal as AbortSignal)
      await gate
      if (signal?.aborted) throw new Error(`cancelled ${query}`)
      return { matches: [], truncated: false }
    }
    const first = orch.searchFiles(taskTarget, 'a')
    const other = orch.searchFiles(folderTarget, 'b')
    const second = orch.searchFiles(taskTarget, 'ab')
    await new Promise((r) => setTimeout(r, 0))
    expect(signals.map((s) => s.aborted)).toEqual([true, false, false])
    release()
    await expect(first).rejects.toThrow('cancelled a')
    await expect(other).resolves.toEqual({ matches: [], truncated: false })
    await expect(second).resolves.toEqual({ matches: [], truncated: false })
    // A finished search is not aborted by the next one.
    const third = orch.searchFiles(taskTarget, 'abc')
    await expect(third).resolves.toBeDefined()
    expect(signals.map((s) => s.aborted)).toEqual([true, false, false, false])
  })

  it('refuses to search a missing root, a repo without a task or an unknown target', async () => {
    const { orch, files, deps, themeId, repoId, taskTarget } = await withTaskAndFolder()
    await expect(orch.searchFiles({ themeId, itemId: repoId }, 'x')).rejects.toThrow('Choose a task to open')
    await expect(orch.searchFiles({ themeId, itemId: 'nope' }, 'x')).rejects.toThrow()
    deps.pathExists = () => false
    await expect(orch.searchFiles(taskTarget, 'x')).rejects.toThrow('Folder not found: /wt/client-x/my-api/fix')
    expect(files.calls).toEqual([])
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

  it('asks for the same usage for a target as for the report, so the two share one cached aggregation', async () => {
    const { orch, usage, taskTarget } = await withTargets()
    await orch.getUsage(taskTarget)
    await orch.getUsageReport()
    await orch.getUsage(taskTarget)
    expect(usage.calls).toHaveLength(3)
    expect(usage.calls[1]).toEqual(usage.calls[0])
    expect(usage.calls[2]).toEqual(usage.calls[0])
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

describe('Orchestrator: budgets', () => {
  const summary = (all: number, today = 0): ReturnType<typeof emptyUsageSummary> => {
    const s = emptyUsageSummary()
    s.all.cost = all
    s.today.cost = today
    return s
  }

  async function withTasks(): Promise<Ctx & { tasks: Task[] }> {
    const ctx = await setup()
    for (const name of ['a', 'b', 'c']) await ctx.orch.createTask(ctx.themeId, ctx.repoId, name)
    await ctx.orch.addFolder(ctx.themeId, '/docs/notes')
    const repo = (await ctx.orch.getState()).themes[0].items[0]
    if (repo.kind !== 'repo') throw new Error('expected repo')
    ctx.usage.calls = []
    return { ...ctx, tasks: repo.tasks }
  }

  it('reports nothing, without reading any usage, while no budget is set', async () => {
    const { orch, usage } = await withTasks()
    expect(await orch.getBudgets()).toEqual({ daily: null, tasks: {} })
    expect(usage.calls).toEqual([])
  })

  it("reports each active task's all-time cost against its own budget or the default one, by task id", async () => {
    const { orch, usage, settings, themeId, repoId, tasks } = await withTasks()
    const [a, b, c] = tasks
    usage.byRoot[a.worktreePath] = summary(4.5)
    usage.byRoot[b.worktreePath] = summary(1)
    usage.byRoot[c.worktreePath] = summary(9)
    await settings.update({ taskBudgetUsd: 5 })
    await orch.setTaskBudget(themeId, repoId, b.id, 1)
    await orch.archiveTask(themeId, repoId, c.id) // archived: never reported
    expect(await orch.getBudgets()).toEqual({
      daily: null,
      tasks: {
        [a.id]: { level: 'warn', spent: 4.5, limit: 5, fraction: 0.9 },
        [b.id]: { level: 'over', spent: 1, limit: 1, fraction: 1 },
      },
    })
    // The same request as getUsage and the report, so the usage service's cached aggregation serves all three.
    await orch.getUsageReport()
    expect(usage.calls[0]).toEqual(usage.calls[1])
  })

  it("reports only tasks with a budget of their own when there is no default, and today's total for the day", async () => {
    const { orch, usage, settings, themeId, repoId, tasks } = await withTasks()
    usage.byRoot[tasks[0].worktreePath] = summary(3)
    usage.byGroup.total = summary(50, 8.5)
    await orch.setTaskBudget(themeId, repoId, tasks[0].id, 10)
    await settings.update({ dailyBudgetUsd: 10 })
    expect(await orch.getBudgets()).toEqual({
      daily: { level: 'warn', spent: 8.5, limit: 10, fraction: 0.85 },
      tasks: { [tasks[0].id]: { level: 'ok', spent: 3, limit: 10, fraction: 0.3 } },
    })
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

describe('Orchestrator: git actions', () => {
  async function withTask(): Promise<Ctx & { target: Target; task: Task }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    ctx.git.calls = []
    ctx.git.statuses.set(task.worktreePath, { ahead: 0, behind: 0, uncommitted: 2, branch: task.branch })
    return { ...ctx, target: { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }, task }
  }

  it('commits all with the trimmed message in the worktree', async () => {
    const { orch, git, target } = await withTask()
    await expect(orch.commitAll(target, '  Fix the login\n\nDetails  ')).resolves.toEqual({ sha: 'abc1234', files: 3 })
    expect(git.calls).toEqual([`commitAll /wt/client-x/my-api/fix "Fix the login\\n\\nDetails"`])
  })

  it('refuses an empty, too long or non-text message before touching git', async () => {
    const { orch, git, target } = await withTask()
    await expect(orch.commitAll(target, '  \n ')).rejects.toThrow('Write a commit message first')
    await expect(orch.commitAll(target, 'x'.repeat(MAX_COMMIT_MESSAGE + 1))).rejects.toThrow(
      'The commit message is limited to 5,000 characters',
    )
    await expect(orch.commitAll(target, 42 as unknown as string)).rejects.toThrow('Write a commit message first')
    await expect(orch.commitAll(target, 'x'.repeat(MAX_COMMIT_MESSAGE))).resolves.toBeDefined()
    expect(git.calls).toHaveLength(1)
  })

  it('pushes the task branch', async () => {
    const { orch, git, target } = await withTask()
    await expect(orch.pushTask(target)).resolves.toEqual({ branch: 'claude/client-x/fix' })
    expect(git.calls).toEqual(['push /wt/client-x/my-api/fix claude/client-x/fix'])
  })

  it("opens a pull request into the base branch's name on GitHub", async () => {
    const { orch, gh, target } = await withTask()
    await expect(orch.getGitTools()).resolves.toEqual({ gh: true })
    await expect(orch.createPullRequest(target)).resolves.toEqual({
      url: 'https://github.com/acme/my-api/pull/7',
      created: true,
    })
    expect(gh.calls).toEqual(['pullRequest /wt/client-x/my-api/fix claude/client-x/fix main'])
    gh.installed = false
    await expect(orch.getGitTools()).resolves.toEqual({ gh: false })
    await expect(orch.createPullRequest(target)).rejects.toThrow(GH_INSTALL_HINT)
  })

  it('reads the git status again after an action, even when it fails', async () => {
    const { orch, git, target, task } = await withTask()
    await orch.getGitStatus([target])
    await orch.getGitStatus([target]) // cached
    expect(git.statusCalls).toHaveLength(1)
    await orch.commitAll(target, 'msg')
    git.statuses.set(task.worktreePath, { ahead: 1, behind: 0, uncommitted: 0, branch: task.branch })
    expect((await orch.getGitStatus([target]))[task.id]).toMatchObject({ ahead: 1, uncommitted: 0 })
    git.failAction = 'git push failed: rejected'
    await expect(orch.pushTask(target)).rejects.toThrow('git push failed: rejected')
    await orch.getGitStatus([target])
    expect(git.statusCalls).toHaveLength(3)
  })

  it('refuses folders, repos without a task and missing worktrees', async () => {
    const { orch, git, deps, themeId, repoId, target, task } = await withTask()
    const folderId = (await orch.addFolder(themeId, '/docs')).themes[0].items[1].id
    await expect(orch.pushTask({ themeId, itemId: folderId })).rejects.toThrow(/only available for repository tasks/)
    await expect(orch.pushTask({ themeId, itemId: repoId })).rejects.toThrow(/only available for repository tasks/)
    deps.pathExists = (p) => p !== task.worktreePath
    await expect(orch.commitAll(target, 'x')).rejects.toThrow(`Folder not found: ${task.worktreePath}`)
    expect(git.calls).toEqual([])
  })

  it("runs one task's actions one at a time, without holding up other mutations", async () => {
    const { orch, git, target } = await withTask()
    let release = (): void => {}
    git.actionGate = new Promise<void>((r) => (release = r))
    const push = orch.pushTask(target)
    const commit = orch.commitAll(target, 'msg')
    await new Promise((r) => setTimeout(r, 0))
    expect(git.calls).toEqual(['push /wt/client-x/my-api/fix claude/client-x/fix']) // commit waits for the push
    await expect(orch.createTheme('Other')).resolves.toBeDefined() // the state queue is free
    release()
    await Promise.all([push, commit])
    expect(git.calls.at(-1)).toMatch(/^commitAll /)
  })

  it('removes a task only after its running git action', async () => {
    const { orch, git, themeId, repoId, target, task } = await withTask()
    let release = (): void => {}
    git.actionGate = new Promise<void>((r) => (release = r))
    const push = orch.pushTask(target)
    const removal = orch.removeTask(themeId, repoId, task.id, false)
    await new Promise((r) => setTimeout(r, 0))
    expect(git.calls).not.toContain(`removeWorktree ${task.worktreePath}`)
    release()
    await push
    await removal
    expect(git.calls.at(-1)).toBe(`removeWorktree ${task.worktreePath}`)
    await expect(orch.pushTask(target)).rejects.toThrow(/not found/i)
  })

  it('lists the uncommitted changes against HEAD', async () => {
    const { orch, files, target } = await withTask()
    await orch.listChanges(target, 'uncommitted')
    await orch.listChanges(target)
    expect(files.calls).toEqual([
      'listChanges /wt/client-x/my-api/fix HEAD',
      'listChanges /wt/client-x/my-api/fix origin/main',
    ])
  })
})

describe('Orchestrator: update from base', () => {
  async function withTask(): Promise<Ctx & { target: Target; task: Task; session: string }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    ctx.git.calls = []
    ctx.tmux.calls = []
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    return { ...ctx, target, task, session: 'mmt_client-x_my-api_fix' }
  }

  it("leaves copy mode in the task's session", async () => {
    const { orch, tmux, target, session } = await withTask()
    await orch.leaveCopyMode(target)
    expect(tmux.calls).toEqual([`leaveCopyMode ${session}`])
  })

  it('fetches, then rebases onto the base by default', async () => {
    const { orch, git, target } = await withTask()
    await expect(orch.updateFromBase(target)).resolves.toEqual({
      kind: 'updated',
      strategy: 'rebase',
      baseRef: 'origin/main',
      commits: 2,
    })
    expect(git.calls).toEqual(['fetch /code/my-api', 'updateFromBase /wt/client-x/my-api/fix origin/main rebase'])
  })

  it('merges when Settings say so, and still updates when the fetch fails', async () => {
    const { orch, git, target } = await withTask()
    await orch.updateSettings({ updateStrategy: 'merge' })
    git.failFetch = true
    await expect(orch.updateFromBase(target)).resolves.toMatchObject({ kind: 'updated', strategy: 'merge' })
    expect(git.calls.at(-1)).toBe('updateFromBase /wt/client-x/my-api/fix origin/main merge')
  })

  it('reports conflicts and passes on refusals', async () => {
    const { orch, git, target } = await withTask()
    git.update = { kind: 'conflict', files: ['src/a.ts'] }
    await expect(orch.updateFromBase(target)).resolves.toEqual({
      kind: 'conflict',
      strategy: 'rebase',
      baseRef: 'origin/main',
      files: ['src/a.ts'],
    })
    git.failAction = 'Commit or stash your changes first: 2 uncommitted files in the task'
    await expect(orch.updateFromBase(target)).rejects.toThrow('Commit or stash your changes first')
  })

  it("runs on the task's queue, after its other git actions", async () => {
    const { orch, git, target } = await withTask()
    let release = (): void => {}
    git.actionGate = new Promise<void>((r) => (release = r))
    const push = orch.pushTask(target)
    const update = orch.updateFromBase(target)
    await new Promise((r) => setTimeout(r, 0))
    expect(git.calls).toEqual(['push /wt/client-x/my-api/fix claude/client-x/fix'])
    release()
    await Promise.all([push, update])
    expect(git.calls.slice(1)).toEqual([
      'fetch /code/my-api',
      'updateFromBase /wt/client-x/my-api/fix origin/main rebase',
    ])
  })

  it("asks Claude in the task's claude window to resolve the conflicts, then shows that window", async () => {
    const { orch, tmux, target, session } = await withTask()
    await orch.newTab(target) // the shell tab is now active
    const tabs = await orch.askClaudeToResolve(target, 'rebase', ['src/a.ts', 'b c.ts'])
    expect(tmux.sent).toEqual([
      `${session}:claude Please rebase this branch onto origin/main and resolve the conflicts in: src/a.ts, b c.ts ⏎`,
    ])
    expect(tabs.find((t) => t.active)?.name).toBe('claude')
    await orch.askClaudeToResolve(target, 'merge', ['x'])
    expect(tmux.sent.at(-1)).toBe(
      `${session}:claude Please merge origin/main into this branch and resolve the conflicts in: x ⏎`,
    )
  })

  it('refuses to press Enter while Claude waits for an answer or is busy, sending nothing', async () => {
    const { orch, tmux, target, session } = await withTask()
    // Enter would pick the highlighted option of a permission prompt or choice menu.
    tmux.panes.set(
      session,
      [
        ' Bash command',
        '   rm -rf dist',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No, and tell Claude what to do differently (esc)',
        '',
      ].join('\n'),
    )
    await expect(orch.askClaudeToResolve(target, 'rebase', ['a.ts'])).rejects.toThrow(
      'Claude is waiting for input — answer it first',
    )
    expect(tmux.captureCalls).toEqual([`${session}:claude`])

    // Working: its spinner printed something within the last few seconds.
    tmux.panes.set(session, ['─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n'))
    tmux.activity.set(session, Math.floor(Date.now() / 1000))
    await expect(orch.askClaudeToResolve(target, 'rebase', ['a.ts'])).rejects.toThrow(
      "Claude is busy — try again when it's idle",
    )
    expect(tmux.sent).toEqual([])

    // Idle at its prompt: the request goes in.
    tmux.activity.set(session, Math.floor(Date.now() / 1000) - 60)
    await orch.askClaudeToResolve(target, 'rebase', ['a.ts'])
    expect(tmux.sent).toHaveLength(1)
  })

  it("restarts Claude with the request when its window was closed, and needs the task's session", async () => {
    const { orch, tmux, promptFiles, target, session } = await withTask()
    await orch.newTab(target)
    await orch.closeTab(target, 0) // the claude window
    await orch.askClaudeToResolve(target, 'rebase', ['a.ts'])
    const file = '/prompts/prompt-1.txt'
    expect(tmux.sessions.get(session)?.windows.at(-1)).toEqual({
      name: 'claude',
      command: `claude --continue -- "$(cat -- ${file})" || claude -- "$(cat -- ${file})"`,
    })
    expect(promptFiles.written.get(file)).toBe(
      'Please rebase this branch onto origin/main and resolve the conflicts in: a.ts ',
    )
    expect(promptFiles.calls).toEqual([`write ${file}`, `release ${file}`])
    expect(tmux.sent).toEqual([])
    tmux.sessions.clear()
    await expect(orch.askClaudeToResolve(target, 'rebase', ['a.ts'])).rejects.toThrow('Open the task first')
  })

  it('builds the request from untrusted file names', () => {
    expect(resolvePrompt('rebase', 'origin/main', ['a\nb.ts', 7, '', 'c\u0007.ts'])).toBe(
      'Please rebase this branch onto origin/main and resolve the conflicts in: a?b.ts, c?.ts',
    )
    const many = Array.from({ length: MAX_RESOLVE_FILES + 5 }, (_, i) => `f${i}`)
    expect(resolvePrompt('merge', 'main', many)).toMatch(/f99 and 5 more$/)
    expect(() => resolvePrompt('rebase', 'main', [])).toThrow('No conflicting files to resolve')
    expect(() => resolvePrompt('rebase', 'main', 'a.ts')).toThrow('No conflicting files to resolve')
    expect(() => resolvePrompt('squash' as 'rebase', 'main', ['a'])).toThrow('Invalid update strategy')
  })

  it('refuses folders', async () => {
    const { orch, themeId } = await withTask()
    const folderId = (await orch.addFolder(themeId, '/docs')).themes[0].items[1].id
    await expect(orch.updateFromBase({ themeId, itemId: folderId })).rejects.toThrow(/only available for repository/)
    await expect(orch.askClaudeToResolve({ themeId, itemId: folderId }, 'rebase', ['a'])).rejects.toThrow(
      /only available for repository/,
    )
  })
})

describe('Orchestrator: sendToClaude', () => {
  async function withTask(): Promise<Ctx & { target: Target; session: string }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    ctx.tmux.calls = []
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    return { ...ctx, target, session: 'mmt_client-x_my-api_fix' }
  }

  const REVIEW = 'Please address these review comments:\n\nsrc/app.ts:12-15\nUse a map here.'

  it('pastes the text into the claude window without pressing Enter, then shows that window', async () => {
    const { orch, tmux, target, session } = await withTask()
    await orch.newTab(target) // the shell tab is now active
    const tabs = await orch.sendToClaude(target, REVIEW)
    expect(tmux.sent).toEqual([`${session}:claude ${REVIEW}`]) // no ⏎: the user submits it
    expect(tabs.find((t) => t.active)?.name).toBe('claude')
  })

  it('works for a folder with a claude tab', async () => {
    const { orch, tmux, themeId } = await withTask()
    const folderId = (await orch.addFolder(themeId, '/docs/notes')).themes[0].items[1].id
    const folder = { themeId, itemId: folderId }
    await orch.openTarget(folder)
    await orch.sendToClaude(folder, 'README.md:3\nTypo')
    expect(tmux.sent).toEqual(['mmf_client-x_notes:claude README.md:3\nTypo'])
  })

  it('refuses while Claude waits for an answer or is busy, sending nothing', async () => {
    const { orch, tmux, target, session } = await withTask()
    tmux.panes.set(session, [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ''].join('\n'))
    await expect(orch.sendToClaude(target, REVIEW)).rejects.toThrow('Claude is waiting for input — answer it first')
    tmux.panes.set(session, ['─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n'))
    tmux.activity.set(session, Math.floor(Date.now() / 1000))
    await expect(orch.sendToClaude(target, REVIEW)).rejects.toThrow("Claude is busy — try again when it's idle")
    expect(tmux.sent).toEqual([])
    tmux.activity.set(session, Math.floor(Date.now() / 1000) - 60)
    await orch.sendToClaude(target, REVIEW)
    expect(tmux.sent).toHaveLength(1)
  })

  it('refuses without a claude tab or a running session, starting nothing', async () => {
    const { orch, tmux, promptFiles, target, session } = await withTask()
    await orch.newTab(target)
    await orch.closeTab(target, 0) // the claude window
    await expect(orch.sendToClaude(target, REVIEW)).rejects.toThrow(
      'There is no Claude tab — start one with “Restart Claude” first',
    )
    expect(tmux.sessions.get(session)?.windows.map((w) => w.name)).toEqual(['shell'])
    expect(promptFiles.calls).toEqual([])
    tmux.sessions.clear()
    await expect(orch.sendToClaude(target, REVIEW)).rejects.toThrow('Open the task first: its session is not running')
    expect(tmux.sent).toEqual([])
  })

  it('refuses an empty, too long or invalid text before touching tmux', async () => {
    const { orch, tmux, target } = await withTask()
    await expect(orch.sendToClaude(target, ' \n ')).rejects.toThrow('Nothing to send to Claude')
    await expect(orch.sendToClaude(target, 7 as unknown as string)).rejects.toThrow('Nothing to send to Claude')
    await expect(orch.sendToClaude(target, 'x'.repeat(MAX_CLAUDE_MESSAGE + 1))).rejects.toThrow(
      'The message for Claude is limited to 50,000 characters',
    )
    expect(tmux.calls).toEqual([])
    expect(tmux.sent).toEqual([])
  })

  it('cleans the text: line endings, control characters, outer blank space', () => {
    expect(claudeMessage('  a\r\nb\rc\td\n\n')).toBe('a\nb\nc\td')
    // An escape could end the bracketed paste early and turn the next newline into Enter.
    expect(claudeMessage('x\u001b[201~\ny\u0000\u0007\u007f')).toBe('x?[201~\ny???')
    expect(claudeMessage('x'.repeat(MAX_CLAUDE_MESSAGE))).toHaveLength(MAX_CLAUDE_MESSAGE)
  })
})

describe('Orchestrator: run command', () => {
  const SESSION = 'mmt_client-x_my-api_fix'
  async function withTask(): Promise<Ctx & { target: Target; worktree: string }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    // No wait between Ctrl-C and the restart, unless a test asks for it.
    const orch = new Orchestrator(ctx.deps, { runGraceMs: 0 })
    await orch.init()
    await orch.setRunCommand(ctx.themeId, ctx.repoId, 'npm run dev')
    ctx.tmux.calls = []
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    return { ...ctx, orch, target, worktree: task.worktreePath }
  }
  const runWindow = (ctx: Ctx): { name: string; command?: string; dead?: true } | undefined =>
    ctx.tmux.sessions.get(SESSION)?.windows.find((w) => w.name === 'run')

  it('saves a repo or folder run command, trimmed, and removes it when empty', async () => {
    const ctx = await setup()
    const s = await ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, '  pnpm dev  ')
    expect(s.themes[0].items[0].runCommand).toBe('pnpm dev')
    expect(ctx.store.saved.at(-1)?.themes[0].items[0].runCommand).toBe('pnpm dev')
    const folderId = (await ctx.orch.addFolder(ctx.themeId, '/docs/site')).themes[0].items[1].id
    expect((await ctx.orch.setRunCommand(ctx.themeId, folderId, 'hugo server')).themes[0].items[1].runCommand).toBe(
      'hugo server',
    )
    expect((await ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, '')).themes[0].items[0]).not.toHaveProperty(
      'runCommand',
    )
    await expect(ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, 'npm run dev\nrm -rf /')).rejects.toThrow(
      'The run command must be one line of text',
    )
  })

  it("starts the repo's command in a run tab of the task's session, in its worktree, kept open when it exits", async () => {
    const ctx = await withTask()
    const tabs = await ctx.orch.startRun(ctx.target)
    expect(ctx.tmux.calls).toEqual([
      `newWindow ${SESSION} run [remain-on-exit] in ${ctx.worktree}: ${runWindowCommand('npm run dev')}`,
    ])
    expect(tabs).toEqual([
      { index: 0, name: 'claude', active: false },
      { index: 1, name: 'run', active: true },
    ])
  })

  it('focuses the run tab when there is one, running or not, instead of starting a second', async () => {
    const ctx = await withTask()
    await ctx.orch.startRun(ctx.target)
    await ctx.orch.selectTab(ctx.target, 0)
    let tabs = await ctx.orch.startRun(ctx.target)
    expect(tabs.map((t) => [t.name, t.active])).toEqual([
      ['claude', false],
      ['run', true],
    ])
    await ctx.orch.stopRun(ctx.target) // now dead: Run still only shows it (Restart runs it again)
    await ctx.orch.selectTab(ctx.target, 0)
    tabs = await ctx.orch.startRun(ctx.target)
    expect(tabs.find((t) => t.active)).toEqual({ index: 1, name: 'run', active: true, dead: true })
    expect(ctx.tmux.calls.filter((c) => c.startsWith('newWindow') || c.startsWith('respawn'))).toHaveLength(1)
  })

  it('starts one run tab when Run is clicked twice at once', async () => {
    const ctx = await withTask()
    await Promise.all([ctx.orch.startRun(ctx.target), ctx.orch.startRun(ctx.target)])
    expect(ctx.tmux.sessions.get(SESSION)?.windows.map((w) => w.name)).toEqual(['claude', 'run'])
  })

  it('runs a folder command in the folder', async () => {
    const ctx = await withTask()
    const folderId = (await ctx.orch.addFolder(ctx.themeId, '/docs/site')).themes[0].items[1].id
    await ctx.orch.setRunCommand(ctx.themeId, folderId, 'hugo server')
    const folder = { themeId: ctx.themeId, itemId: folderId }
    await ctx.orch.openTarget(folder)
    await ctx.orch.startRun(folder)
    expect(ctx.tmux.calls.at(-1)).toBe(
      `newWindow mmf_client-x_site run [remain-on-exit] in /docs/site: ${runWindowCommand('hugo server')}`,
    )
  })

  it('refuses without a run command or a running session, starting nothing', async () => {
    const ctx = await withTask()
    await ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, '')
    await expect(ctx.orch.startRun(ctx.target)).rejects.toThrow('Set a run command for “my-api” first')
    await expect(ctx.orch.restartRun(ctx.target)).rejects.toThrow('Set a run command for “my-api” first')
    await ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, 'npm run dev')
    ctx.tmux.sessions.clear()
    await expect(ctx.orch.startRun(ctx.target)).rejects.toThrow('Open the task first: its session is not running')
    expect(ctx.tmux.calls).toEqual([])
  })

  it('restarts a running command: Ctrl-C, a short wait, then the current command in the same tab', async () => {
    const ctx = await withTask()
    await ctx.orch.startRun(ctx.target)
    ctx.tmux.interruptEffect.set(`${SESSION}:run`, 'ignore') // still running after Ctrl-C: respawn -k kills it
    await ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, 'npm run dev -- --port 4000') // edited meanwhile
    await ctx.orch.selectTab(ctx.target, 0)
    ctx.tmux.calls = []
    const tabs = await ctx.orch.restartRun(ctx.target)
    expect(ctx.tmux.calls).toEqual([
      `sendInterrupt ${SESSION} run`,
      `respawnWindow ${SESSION} run in ${ctx.worktree}: ${runWindowCommand('npm run dev -- --port 4000')}`,
    ])
    expect(tabs.find((t) => t.active)).toEqual({ index: 1, name: 'run', active: true })
  })

  it('waits RUN_RESTART_GRACE_MS between Ctrl-C and the restart by default', async () => {
    const ctx = await withTask()
    await ctx.orch.startRun(ctx.target)
    const orch = new Orchestrator(ctx.deps)
    await orch.init()
    vi.useFakeTimers()
    try {
      const restart = orch.restartRun(ctx.target)
      await vi.advanceTimersByTimeAsync(RUN_RESTART_GRACE_MS - 1)
      expect(ctx.tmux.calls.filter((c) => c.startsWith('respawn'))).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await restart
      expect(ctx.tmux.calls.filter((c) => c.startsWith('respawn'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    expect(RUN_RESTART_GRACE_MS).toBe(500)
  })

  it('restarts a stopped command without Ctrl-C, and starts one when there is no run tab', async () => {
    const ctx = await withTask()
    await ctx.orch.startRun(ctx.target)
    await ctx.orch.stopRun(ctx.target)
    expect(runWindow(ctx)?.dead).toBe(true)
    ctx.tmux.calls = []
    await ctx.orch.restartRun(ctx.target)
    expect(ctx.tmux.calls).toEqual([
      `respawnWindow ${SESSION} run in ${ctx.worktree}: ${runWindowCommand('npm run dev')}`,
    ])
    expect(runWindow(ctx)?.dead).toBeUndefined()
    await ctx.orch.closeTab(ctx.target, 1)
    ctx.tmux.calls = []
    await ctx.orch.restartRun(ctx.target)
    expect(ctx.tmux.calls).toEqual([
      `newWindow ${SESSION} run [remain-on-exit] in ${ctx.worktree}: ${runWindowCommand('npm run dev')}`,
    ])
  })

  it('stops a running command with Ctrl-C, keeping its tab, and leaves a stopped or missing one alone', async () => {
    const ctx = await withTask()
    expect(await ctx.orch.stopRun(ctx.target)).toEqual([{ index: 0, name: 'claude', active: true }])
    await ctx.orch.startRun(ctx.target)
    const tabs = await ctx.orch.stopRun(ctx.target)
    expect(tabs.find((t) => t.name === 'run')).toEqual({ index: 1, name: 'run', active: true, dead: true })
    await ctx.orch.stopRun(ctx.target)
    expect(ctx.tmux.calls.filter((c) => c.startsWith('sendInterrupt'))).toHaveLength(1)
    // Stopping needs no run command: it may have been removed while the tab ran.
    await ctx.orch.setRunCommand(ctx.themeId, ctx.repoId, '')
    await ctx.orch.restartRun(ctx.target).catch(() => {})
    await expect(ctx.orch.stopRun(ctx.target)).resolves.toHaveLength(2)
  })

  it('never touches an archived task', async () => {
    const ctx = await withTask()
    await ctx.orch.archiveTask(ctx.themeId, ctx.repoId, ctx.target.taskId!)
    ctx.tmux.calls = []
    for (const call of [ctx.orch.startRun, ctx.orch.restartRun, ctx.orch.stopRun])
      await expect(call.call(ctx.orch, ctx.target)).rejects.toThrow('"fix" is archived: restore it first')
    expect(ctx.tmux.calls).toEqual([])
  })

  it('runs the command with the shell after printing it, quoted, so only the command itself is shell', () => {
    const run = (command: string): string => execFileSync('sh', ['-c', runWindowCommand(command)], { encoding: 'utf8' })
    expect(run('echo $((1 + 1))')).toBe('$ echo $((1 + 1))\n2\n')
    expect(run(`printf '%s\\n' "it's" ok`)).toBe(`$ printf '%s\\n' "it's" ok\nit's\nok\n`)
    expect(run('echo `echo hi` $(echo there) %s')).toBe('$ echo `echo hi` $(echo there) %s\nhi there %s\n')
  })
})

describe('Orchestrator: dev-server URLs', () => {
  const SESSION = 'mmt_client-x_my-api_fix'
  /** A clock the tests move by hand, in ms; starts at second 1000. */
  async function withTask(): Promise<Ctx & { target: Target; clock: { ms: number } }> {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const clock = { ms: 1_000_000 }
    const orch = new Orchestrator(ctx.deps, { now: () => clock.ms })
    await orch.init()
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    await orch.newTab(target) // shell
    await orch.newTab(target) // shell 2
    return { ...ctx, orch, target, clock }
  }
  /** What a tab printed, and when (Unix seconds). */
  const print = (ctx: Ctx, tab: string, text: string, atSec: number): void => {
    ctx.tmux.tails.set(`${SESSION}:${tab}`, text)
    ctx.tmux.windowActivitySec.set(`${SESSION}:${tab}`, atSec)
  }

  it("lists the URLs printed in the target's tabs with their tab, the tab that printed last first", async () => {
    const ctx = await withTask()
    print(ctx, 'shell', '  ➜  Local:   http://localhost:5173/\n', 990)
    print(ctx, 'shell 2', '* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000\n', 995)
    print(ctx, 'claude', 'Started the server: http://localhost:5173/ (already listed)', 900)
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([
      { url: 'http://[::1]:3000/', index: 2, tab: 'shell 2' },
      { url: 'http://127.0.0.1:3000/', index: 2, tab: 'shell 2' },
      { url: 'http://localhost:5173/', index: 1, tab: 'shell' },
    ])
    expect(ctx.tmux.tailCalls.sort()).toEqual(
      [`${SESSION}:claude`, `${SESSION}:shell`, `${SESSION}:shell 2`]
        .map((w) => `${w} ${DEV_URL_SCROLLBACK_LINES}`)
        .sort(),
    )
    expect(DEV_URL_SCROLLBACK_LINES).toBe(200)
  })

  it('reports at most 5, the newest', async () => {
    const ctx = await withTask()
    print(ctx, 'shell', [3000, 3001, 3002, 3003, 3004, 3005, 3006].map((p) => `http://localhost:${p}`).join('\n'), 990)
    const urls = await ctx.orch.getDevUrls(ctx.target)
    expect(urls.map((u) => u.url)).toEqual([3006, 3005, 3004, 3003, 3002].map((p) => `http://localhost:${p}/`))
  })

  it('captures a tab again only once it printed something, and at most every few seconds', async () => {
    const ctx = await withTask()
    print(ctx, 'shell', 'starting…', 990)
    await ctx.orch.getDevUrls(ctx.target)
    expect(ctx.tmux.tailCalls).toHaveLength(3)
    ctx.tmux.tailCalls = []
    ctx.clock.ms += 60_000
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([]) // nothing printed since: no capture
    expect(ctx.tmux.tailCalls).toEqual([])

    print(ctx, 'shell', 'starting…\nLocal: http://localhost:4000', 1061)
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([
      { url: 'http://localhost:4000/', index: 1, tab: 'shell' },
    ])
    expect(ctx.tmux.tailCalls).toEqual([`${SESSION}:shell 200`])

    // It keeps printing (a busy log): captured again only once DEV_URL_RESCAN_MS have passed.
    ctx.tmux.tailCalls = []
    print(ctx, 'shell', 'Local: http://localhost:4001', 1062)
    ctx.clock.ms += DEV_URL_RESCAN_MS - 1
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([
      { url: 'http://localhost:4000/', index: 1, tab: 'shell' },
    ])
    ctx.clock.ms += 1
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([
      { url: 'http://localhost:4001/', index: 1, tab: 'shell' },
    ])
    expect(ctx.tmux.tailCalls).toEqual([`${SESSION}:shell 200`])
  })

  it('captures again a tab that printed in the second it was captured, which may have missed the end', async () => {
    const ctx = await withTask()
    print(ctx, 'shell', 'VITE v5 ready', 1000) // the clock is at second 1000 too
    await ctx.orch.getDevUrls(ctx.target)
    print(ctx, 'shell', 'VITE v5 ready\n  Local: http://localhost:5173/', 1000) // same second
    ctx.clock.ms += DEV_URL_RESCAN_MS
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([
      { url: 'http://localhost:5173/', index: 1, tab: 'shell' },
    ])
    ctx.tmux.tailCalls = []
    ctx.clock.ms += DEV_URL_RESCAN_MS
    await ctx.orch.getDevUrls(ctx.target) // captured after that second: settled
    expect(ctx.tmux.tailCalls).toEqual([])
  })

  it('drops the URLs of a tab once it is closed', async () => {
    const ctx = await withTask()
    print(ctx, 'shell 2', 'http://localhost:8000/', 990)
    expect(await ctx.orch.getDevUrls(ctx.target)).toHaveLength(1)
    await ctx.orch.closeTab(ctx.target, 2)
    await expect(ctx.orch.getDevUrls(ctx.target)).resolves.toEqual([])
  })

  it('works for folders, is empty without a session, and never touches an archived task', async () => {
    const ctx = await withTask()
    const folderId = (await ctx.orch.addFolder(ctx.themeId, '/docs/site')).themes[0].items[1].id
    const folder = { themeId: ctx.themeId, itemId: folderId }
    await expect(ctx.orch.getDevUrls(folder)).resolves.toEqual([]) // not opened yet
    await ctx.orch.openTarget(folder)
    ctx.tmux.tails.set('mmf_client-x_site:claude', 'Web Server is available at http://localhost:1313/')
    await expect(ctx.orch.getDevUrls(folder)).resolves.toEqual([
      { url: 'http://localhost:1313/', index: 0, tab: 'claude' },
    ])
    await ctx.orch.archiveTask(ctx.themeId, ctx.repoId, ctx.target.taskId!)
    ctx.tmux.tailCalls = []
    await expect(ctx.orch.getDevUrls(ctx.target)).rejects.toThrow('"fix" is archived: restore it first')
    expect(ctx.tmux.tailCalls).toEqual([])
  })
})

describe('Orchestrator: UI state', () => {
  it('hands back the saved UI state, without targets that are gone', async () => {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    ctx.ui.stored = {
      version: 1,
      selected: target,
      collapsed: [ctx.themeId, 'removed-repo'],
      panels: { [task.id]: { open: true, tab: 'changes', selected: 'a.ts' }, removed: { open: true, tab: 'files' } },
      sidebarFilter: 'fix',
    }
    await expect(ctx.orch.getUiState()).resolves.toEqual({
      version: 1,
      selected: target,
      collapsed: [ctx.themeId],
      panels: { [task.id]: { open: true, tab: 'changes', selected: 'a.ts' } },
      sidebarFilter: 'fix',
    })
    await ctx.orch.removeTask(ctx.themeId, ctx.repoId, task.id, false)
    await expect(ctx.orch.getUiState()).resolves.toEqual({
      version: 1,
      collapsed: [ctx.themeId],
      panels: {},
      sidebarFilter: 'fix',
    })
  })

  it('normalizes what the renderer sends before saving it', async () => {
    const ctx = await setup()
    await ctx.orch.saveUiState({
      version: 1,
      selected: { themeId: ctx.themeId, itemId: ctx.repoId, taskId: 'nope' },
      collapsed: [ctx.repoId, 'x'],
      panels: {},
      panelWidth: 9,
      junk: true,
    } as never)
    expect(ctx.ui.saved).toEqual([{ version: 1, collapsed: [ctx.repoId], panels: {} }])
  })

  it('treats an unreadable store as an empty UI state', async () => {
    const ctx = await setup()
    ctx.ui.stored = 'garbage'
    await expect(ctx.orch.getUiState()).resolves.toEqual({ version: 1, collapsed: [], panels: {} })
  })
})
