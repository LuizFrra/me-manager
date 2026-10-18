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
    await expect(api.readFile(task, 'assets/icon.png')).resolves.toEqual({ kind: 'binary', size: 2048 })
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
})
