import type { AppState, Task } from '../../../shared/types'
import { describe, expect, it } from 'vitest'
import { createMockApi } from './mockApi'

describe('createMockApi', () => {
  it('supports theme, repo and task flows', async () => {
    const api = createMockApi({ pickDirectory: async () => '/code/my-api' })
    let s = await api.createTheme('Client X')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, (await api.pickDirectory())!)
    const repo = s.themes[0].items[0]
    expect(repo).toMatchObject({ kind: 'repo', name: 'my-api' })
    s = await api.createTask(themeId, repo.id, 'fix login')
    const task = s.themes[0].items[0].kind === 'repo' ? s.themes[0].items[0].tasks[0] : null
    expect(task).toMatchObject({ name: 'fix login', branch: 'claude/client-x/fix-login' })
  })
  it('archives and restores a task, refusing each twice', async () => {
    const api = createMockApi()
    let s = await api.createTheme('T')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, '/code/r')
    const repoId = s.themes[0].items[0].id
    s = await api.createTask(themeId, repoId, 'fix')
    const taskId = s.themes[0].items[0].kind === 'repo' ? s.themes[0].items[0].tasks[0].id : ''
    s = await api.archiveTask(themeId, repoId, taskId)
    expect(s.themes[0].items[0]).toMatchObject({ tasks: [{ archivedAt: expect.any(String) }] })
    await expect(api.archiveTask(themeId, repoId, taskId)).rejects.toThrow('"fix" is already archived')
    s = await api.unarchiveTask(themeId, repoId, taskId)
    expect(s.themes[0].items[0]).not.toMatchObject({ tasks: [{ archivedAt: expect.anything() }] })
    await expect(api.unarchiveTask(themeId, repoId, taskId)).rejects.toThrow('"fix" is not archived')
  })
  it('moves themes, items and active tasks like main, refusing an archived task', async () => {
    const api = createMockApi()
    let s = await api.createTheme('A')
    const themeId = s.themes[0].id
    await api.createTheme('B')
    await api.addFolder(themeId, '/f/notes')
    s = await api.addRepo(themeId, '/code/r')
    const repoId = s.themes[0].items[1].id
    for (const name of ['one', 'old', 'two']) s = await api.createTask(themeId, repoId, name)
    const repo = s.themes[0].items[1]
    const [one, old, two] = repo.kind === 'repo' ? repo.tasks.map((t) => t.id) : []
    await api.archiveTask(themeId, repoId, old)
    s = await api.moveTheme(themeId, 9)
    expect(s.themes.map((t) => t.name)).toEqual(['B', 'A'])
    s = await api.moveItem(themeId, repoId, 0)
    expect(s.themes[1].items.map((i) => i.name)).toEqual(['r', 'notes'])
    s = await api.moveTask(themeId, repoId, two, 0)
    expect(s.themes[1].items[0]).toMatchObject({ tasks: [{ id: two }, { id: old }, { id: one }] })
    await expect(api.moveTask(themeId, repoId, old, 0)).rejects.toThrow('"old" is archived: restore it first')
    await expect(api.moveTheme('nope', 0)).rejects.toThrow('Theme not found: nope')
    await expect(api.moveItem(themeId, 'nope', 0)).rejects.toThrow('Item not found: nope')
  })
  it('lists demo branches and creates tasks from a chosen one', async () => {
    const api = createMockApi()
    let s = await api.createTheme('T')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, '/code/r')
    const repoId = s.themes[0].items[0].id
    const { default: base, branches } = await api.listBranches(themeId, repoId)
    expect(branches[0]).toBe(base)
    s = await api.createTask(themeId, repoId, 'a', { baseRef: 'origin/develop', prompt: 'go' })
    expect(s.themes[0].items[0]).toMatchObject({ tasks: [{ baseRef: 'origin/develop' }] })
    await expect(api.createTask(themeId, repoId, 'b', { baseRef: 'origin/nope' })).rejects.toThrow(/Unknown/)
  })
  it('commits, pushes and opens a demo pull request', async () => {
    const api = createMockApi()
    let s = await api.createTheme('T')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, '/code/r')
    const itemId = s.themes[0].items[0].id
    s = await api.createTask(themeId, itemId, 'fix')
    const repo = s.themes[0].items[0]
    const target = { themeId, itemId, taskId: repo.kind === 'repo' ? repo.tasks[0].id : '' }
    await expect(api.getGitTools()).resolves.toEqual({ gh: true })
    await expect(api.commitAll(target, ' ')).rejects.toThrow(/commit message/)
    await expect(api.commitAll(target, 'msg')).resolves.toMatchObject({ files: 3 })
    await expect(api.pushTask(target)).resolves.toEqual({ branch: 'claude/t/fix' })
    await expect(api.createPullRequest(target)).resolves.toMatchObject({ created: true })
    await expect(api.createPullRequest(target)).resolves.toMatchObject({ created: false })
  })
  it('updates demo tasks from their base, with a conflict for tasks named so', async () => {
    const api = createMockApi()
    let s = await api.createTheme('T')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, '/code/r')
    const itemId = s.themes[0].items[0].id
    await api.createTask(themeId, itemId, 'fix')
    s = await api.createTask(themeId, itemId, 'conflict')
    const repo = s.themes[0].items[0]
    const [fix, conflict] = repo.kind === 'repo' ? repo.tasks.map((t) => ({ themeId, itemId, taskId: t.id })) : []
    await expect(api.updateFromBase(fix)).resolves.toMatchObject({ kind: 'updated', strategy: 'rebase', commits: 2 })
    await expect(api.updateFromBase(fix)).resolves.toMatchObject({ kind: 'upToDate' })
    const result = await api.updateFromBase(conflict)
    expect(result).toMatchObject({ kind: 'conflict', baseRef: 'origin/main' })
    await expect(api.askClaudeToResolve(conflict, 'rebase', ['a.ts'])).resolves.toHaveLength(1)
  })
  it('takes review comments for Claude, refusing an empty text', async () => {
    const api = createMockApi()
    const s = await api.addFolder((await api.createTheme('T')).themes[0].id, '/notes')
    const folder = { themeId: s.themes[0].id, itemId: s.themes[0].items[0].id }
    await expect(api.sendToClaude(folder, 'README.md:3\nTypo')).resolves.toEqual([
      { index: 0, name: 'claude', active: true },
    ])
    await expect(api.sendToClaude(folder, '  ')).rejects.toThrow('Nothing to send to Claude')
  })
  it('renames themes and tasks, rejecting empty and duplicate names', async () => {
    const api = createMockApi()
    let s = await api.createTheme('Client X')
    const themeId = s.themes[0].id
    await api.createTheme('Personal')
    s = await api.addRepo(themeId, '/code/my-api')
    const repoId = s.themes[0].items[0].id
    s = await api.createTask(themeId, repoId, 'fix')
    await api.createTask(themeId, repoId, 'docs')
    const taskId = s.themes[0].items[0].kind === 'repo' ? s.themes[0].items[0].tasks[0].id : ''
    s = await api.renameTheme(themeId, ' Client Y ')
    expect(s.themes[0]).toMatchObject({ name: 'Client Y', slug: 'client-x' })
    s = await api.renameTask(themeId, repoId, taskId, 'Fix login')
    expect(s.themes[0].items[0]).toMatchObject({ tasks: [{ name: 'Fix login', slug: 'fix' }, { name: 'docs' }] })
    await expect(api.renameTheme(themeId, 'personal')).rejects.toThrow(/already exists/)
    await expect(api.renameTask(themeId, repoId, taskId, 'DOCS')).rejects.toThrow(/already exists/)
    await expect(api.renameTask(themeId, repoId, taskId, '  ')).rejects.toThrow(/empty/)
  })

  it('sets and clears task notes', async () => {
    const api = createMockApi()
    let s = await api.createTheme('T')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, '/code/r')
    const repoId = s.themes[0].items[0].id
    s = await api.createTask(themeId, repoId, 'fix')
    const taskOf = (st: typeof s): Record<string, unknown> =>
      st.themes[0].items[0].kind === 'repo' ? { ...st.themes[0].items[0].tasks[0] } : {}
    const taskId = taskOf(s).id as string
    expect(taskOf(await api.setTaskNotes(themeId, repoId, taskId, ' hi '))).toMatchObject({ notes: 'hi' })
    expect(taskOf(await api.setTaskNotes(themeId, repoId, taskId, ''))).not.toHaveProperty('notes')
    await expect(api.setTaskNotes(themeId, repoId, taskId, 'x'.repeat(2001))).rejects.toThrow(/2000/)
  })

  it('applies overrides', async () => {
    const api = createMockApi({ checkPrereqs: async () => ({ ok: false, missing: [] }) })
    await expect(api.checkPrereqs()).resolves.toEqual({ ok: false, missing: [] })
  })

  it('serves a demo file set with changes for tasks', async () => {
    const api = createMockApi()
    const task = { themeId: 't', itemId: 'r', taskId: 'k' }
    const files = await api.listFiles(task)
    expect(files.truncated).toBe(false)
    expect(files.paths).toEqual(expect.arrayContaining(['README.md', 'src/app.ts']))
    await expect(api.readFile(task, 'README.md')).resolves.toMatchObject({ kind: 'text', truncated: false })
    await expect(api.readFile(task, 'assets/icon.png')).resolves.toEqual({ kind: 'binary', size: 117, mtimeMs: 0 })
    await expect(api.readImage(task, 'assets/icon.png')).resolves.toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
    await expect(api.readFile(task, 'nope.ts')).resolves.toEqual({ kind: 'missing' })
    await expect(api.readImage(task, 'assets/logo.svg')).resolves.toMatch(/^data:image\/svg\+xml;base64,/)
    const changes = await api.listChanges(task)
    expect(changes.files.map((f) => f.status)).toEqual(['U', 'M', 'D', 'A'])
    await expect(api.fileDiff(task, 'src/app.ts')).resolves.toContain('@@')
    await expect(api.listChanges({ themeId: 't', itemId: 'f' })).rejects.toThrow('repository tasks')
  })

  it('keeps settings, normalizing updates like main does', async () => {
    const api = createMockApi()
    expect(await api.getSettings()).toMatchObject({ claudeArgs: [], pollIntervalMs: 3000, terminalFontSize: 13 })
    const next = await api.updateSettings({ claudeArgs: ['--model', 'opus'], terminalFontSize: 99 })
    expect(next).toMatchObject({ claudeArgs: ['--model', 'opus'], terminalFontSize: 32 })
    expect(await api.getSettings()).toEqual(next)
  })

  it('reports stable demo usage per target, summed per theme and overall', async () => {
    const api = createMockApi()
    let s = await api.createTheme('Client X')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, '/code/my-api')
    const repoId = s.themes[0].items[0].id
    await api.createTask(themeId, repoId, 'fix')
    s = await api.addFolder(themeId, '/docs/notes')
    const repo = s.themes[0].items[0]
    const taskId = repo.kind === 'repo' ? repo.tasks[0].id : ''
    const target = { themeId, itemId: repoId, taskId }
    const usage = await api.getUsage(target)
    expect(usage.all.cost).toBeGreaterThan(0)
    expect(usage.today.cost).toBeLessThan(usage.week.cost)
    expect(await api.getUsage(target)).toEqual(usage)

    const report = await api.getUsageReport()
    const theme = report.themes[0]
    expect(theme.targets.map((t) => [t.kind, t.label])).toEqual([
      ['task', 'my-api › fix'],
      ['folder', 'notes'],
    ])
    expect(theme.targets[0].usage).toEqual(usage)
    const sum = theme.targets.reduce((n, t) => n + t.usage.all.cost, 0)
    expect(theme.usage.all.cost).toBeCloseTo(sum)
    expect(report.total.all.cost).toBeCloseTo(sum)
  })

  it("sets and clears a task's own budget like main", async () => {
    const api = createMockApi()
    const themeId = (await api.createTheme('Client X')).themes[0].id
    const repoId = (await api.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const repo = (await api.createTask(themeId, repoId, 'fix')).themes[0].items[0]
    const taskId = repo.kind === 'repo' ? repo.tasks[0].id : ''
    const budgetOf = (s: AppState): number | undefined => {
      const r = s.themes[0].items[0]
      return r.kind === 'repo' ? r.tasks[0].budgetUsd : undefined
    }
    await expect(api.setTaskBudget(themeId, repoId, taskId, 0)).rejects.toThrow(/The budget must be an amount/)
    expect(budgetOf(await api.setTaskBudget(themeId, repoId, taskId, 2.345))).toBe(2.35)
    expect(budgetOf(await api.setTaskBudget(themeId, repoId, taskId, null))).toBeUndefined()

    expect(await api.getBudgets()).toEqual({ daily: null, tasks: {} })
    await api.updateSettings({ dailyBudgetUsd: 100_000, taskBudgetUsd: 0.01 })
    const budgets = await api.getBudgets()
    expect(budgets.tasks[taskId]).toMatchObject({ level: 'over', limit: 0.01 })
    expect(budgets.daily).toMatchObject({ level: 'ok', limit: 100_000 })
  })

  it("sets and clears a theme's and a task's Claude profile like main", async () => {
    const api = createMockApi()
    const themeId = (await api.createTheme('Client X')).themes[0].id
    const repoId = (await api.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const repo = (await api.createTask(themeId, repoId, 'fix')).themes[0].items[0]
    const taskId = repo.kind === 'repo' ? repo.tasks[0].id : ''
    const taskOf = (s: AppState): Task | undefined => {
      const r = s.themes[0].items[0]
      return r.kind === 'repo' ? r.tasks[0] : undefined
    }
    await expect(api.setThemeProfile(themeId, 'nope')).rejects.toThrow('Claude account not found')
    expect((await api.setThemeProfile(themeId, 'default')).themes[0].profileId).toBe('default')
    expect((await api.setThemeProfile(themeId, null)).themes[0]).not.toHaveProperty('profileId')
    await expect(api.setTaskProfile(themeId, repoId, taskId, 'nope')).rejects.toThrow('Claude account not found')
    expect(taskOf(await api.setTaskProfile(themeId, repoId, taskId, 'default'))?.profileId).toBe('default')
    expect(taskOf(await api.setTaskProfile(themeId, repoId, taskId, null))).not.toHaveProperty('profileId')
  })

  it('adds, edits and removes Claude profiles like main', async () => {
    const api = createMockApi()
    expect(await api.listProfiles()).toEqual([
      {
        id: 'default',
        name: 'Default',
        configDir: '/home/demo/.claude',
        billing: 'own',
        isDefault: true,
        login: 'signedIn',
      },
    ])
    let list = await api.addProfile({ name: ' Work ', configDir: '~/.claude-work', billing: 'company' })
    expect(list[1]).toMatchObject({
      name: 'Work',
      configDir: '/home/demo/.claude-work',
      billing: 'company',
      isDefault: false,
      login: 'notSignedIn',
    })
    const workId = list[1].id
    await expect(api.addProfile({ name: 'work', configDir: '/x', billing: 'own' })).rejects.toThrow('named “Work”')
    await expect(api.addProfile({ name: 'X', configDir: '/home/demo/.claude', billing: 'own' })).rejects.toThrow(
      '“Default” already uses this folder',
    )
    list = await api.updateProfile(workId, { name: 'Company', billing: 'own' })
    expect(list[1]).toMatchObject({ name: 'Company', billing: 'own', configDir: '/home/demo/.claude-work' })
    expect((await api.updateProfile('default', { billing: 'company' }))[0].billing).toBe('company')
    await expect(api.updateProfile('default', { name: 'Mine' })).rejects.toThrow("Default can't be renamed")

    const themeId = (await api.createTheme('Client X')).themes[0].id
    await api.setThemeProfile(themeId, workId)
    await expect(api.removeProfile(workId)).rejects.toThrow('Used by Client X')
    await expect(api.removeProfile('default')).rejects.toThrow("Default can't be removed")
    await api.setThemeProfile(themeId, null)
    expect((await api.removeProfile(workId)).map((p) => p.id)).toEqual(['default'])
  })

  it("runs a repo's command in a run tab like main, with a demo URL while it runs", async () => {
    const api = createMockApi()
    const themeId = (await api.createTheme('Client X')).themes[0].id
    const repoId = (await api.addRepo(themeId, '/code/my-api')).themes[0].items[0].id
    const target = { themeId, itemId: repoId }
    await expect(api.startRun(target)).rejects.toThrow('Set a run command for “my-api” first')
    await expect(api.setRunCommand(themeId, repoId, 'a\nb')).rejects.toThrow('one line')
    expect((await api.setRunCommand(themeId, repoId, ' npm run dev ')).themes[0].items[0].runCommand).toBe(
      'npm run dev',
    )
    const tabs = await api.startRun(target)
    expect(tabs.map((t) => [t.name, t.active])).toEqual([
      ['claude', false],
      ['run', true],
    ])
    await expect(api.getDevUrls(target)).resolves.toEqual([{ url: 'http://localhost:5173/', index: 1, tab: 'run' }])
    expect((await api.stopRun(target)).find((t) => t.name === 'run')?.dead).toBe(true)
    await expect(api.getDevUrls(target)).resolves.toEqual([])
    expect((await api.restartRun(target)).find((t) => t.name === 'run')?.dead).toBeUndefined()
    expect((await api.setRunCommand(themeId, repoId, '')).themes[0].items[0]).not.toHaveProperty('runCommand')
  })
})
