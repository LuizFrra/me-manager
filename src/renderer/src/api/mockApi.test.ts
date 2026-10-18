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
})
