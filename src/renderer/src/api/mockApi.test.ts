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
})
