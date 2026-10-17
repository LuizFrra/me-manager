import { render, screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createMockApi } from './api/mockApi'

vi.mock('./components/TerminalView', () => ({ TerminalView: () => <div data-testid="terminal" /> }))

async function createTheme(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'New theme' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: `Remove theme ${name}` })
}

async function createRepoAndTask(user: UserEvent): Promise<void> {
  await createTheme(user, 'Client X')
  await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
  await user.click(await screen.findByRole('button', { name: 'New task in my-api' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'fix login bug')
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: 'Remove task fix login bug' })
}

const repoApi = (extra = {}) => createMockApi({ pickDirectory: async () => '/home/me/code/my-api', ...extra })

describe('App', () => {
  it('creates a theme', async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi()} />)
    await createTheme(user, 'Client X')
    expect(screen.getByText(/Client X/)).toBeInTheDocument()
  })

  it('adds a repo, creates a task and opens it', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(await screen.findByRole('tab', { name: 'claude' })).toBeInTheDocument()
    expect(openTarget).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }))
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
  })

  it('removes a clean task without asking and deletes its branch', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const removeTask = vi.spyOn(api, 'removeTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Remove task fix login bug' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(removeTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), true)
  })

  it('asks before removing a task with unsaved work', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      checkTaskRemoval: async () => ({ uncommittedFiles: ['src/login.ts'], unpushedCommits: [] }),
    })
    const removeTask = vi.spyOn(api, 'removeTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Remove task fix login bug' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('src/login.ts')).toBeInTheDocument()
    expect(removeTask).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Remove anyway' }))
    expect(removeTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), false)
  })

  it('shows backend errors as toasts', async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      createTheme: async () => {
        throw new Error("Error invoking remote method 'api:createTheme': Error: A theme named \"X\" already exists")
      },
    })
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: 'New theme' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'X')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A theme named "X" already exists')
  })

  it('shows the missing tools screen', async () => {
    render(
      <App
        api={createMockApi({
          checkPrereqs: async () => ({ ok: false, missing: [{ tool: 'tmux', hint: 'Run: sudo apt install tmux' }] }),
        })}
      />,
    )
    expect(await screen.findByText('Run: sudo apt install tmux')).toBeInTheDocument()
  })
})
