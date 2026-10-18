import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createMockApi } from './api/mockApi'
import type { MeManagerApi, TabInfo, Target } from '../../shared/types'

vi.mock('./components/TerminalView', () => ({ TerminalView: () => <div data-testid="terminal" /> }))
vi.mock('./components/files/MarkdownView', () => ({
  MarkdownView: ({ source }: { source: string }) => <div data-testid="markdown">MD:{source}</div>,
}))
vi.mock('./components/files/DiffView', () => ({
  DiffView: ({ diff }: { diff: string }) => <pre data-testid="diff">DIFF:{diff}</pre>,
}))

async function createTheme(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'New theme' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: `Remove theme ${name}` })
}

async function createTask(user: UserEvent, name: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'New task in my-api' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: `Remove task ${name}` })
}

async function createRepoAndTask(user: UserEvent, ...names: string[]): Promise<void> {
  await createTheme(user, 'Client X')
  await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
  for (const name of names.length ? names : ['fix login bug']) await createTask(user, name)
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

interface Hold {
  task?: string
  gate?: Deferred
}

/** The sidebar button for a task; its label may start with a status dot. */
const taskButton = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^(\\S )?${name}$`) })

/** Each task reports tabs named after it; `hold` delays responses for one task until released. */
function perTaskTabs(getApi: () => MeManagerApi, hold: Hold): (target: Target) => Promise<TabInfo[]> {
  return async (target) => {
    const state = await getApi().getState()
    const repo = state.themes.flatMap((t) => t.items).find((i) => i.id === target.itemId)
    const name = repo?.kind === 'repo' ? (repo.tasks.find((k) => k.id === target.taskId)?.name ?? '?') : '?'
    if (hold.task === name) await hold.gate?.promise
    return [{ index: 0, name: `${name} tab`, active: true }]
  }
}

const repoApi = (extra: Partial<MeManagerApi> = {}): MeManagerApi =>
  createMockApi({ pickDirectory: async () => '/home/me/code/my-api', ...extra })

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

  it('ignores an openTarget response that arrives after another target was selected', async () => {
    const user = userEvent.setup()
    const hold: Hold = {}
    const tabsFor = perTaskTabs(() => api, hold)
    const api: MeManagerApi = repoApi({ openTarget: tabsFor, listTabs: () => new Promise<TabInfo[]>(() => {}) })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')

    hold.task = 'task A'
    hold.gate = deferred()
    await user.click(taskButton('task A'))
    await user.click(taskButton('task B'))
    expect(await screen.findByRole('tab', { name: 'task B tab' })).toBeInTheDocument()

    hold.gate.resolve()
    await act(async () => {
      await hold.gate?.promise
    })
    expect(screen.getByText('my-api › task B')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'task A tab' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'task B tab' })).toBeInTheDocument()
  })

  it('ignores a tab action response that arrives after another target was selected', async () => {
    const user = userEvent.setup()
    const hold: Hold = {}
    const tabsFor = perTaskTabs(() => api, hold)
    const api: MeManagerApi = repoApi({
      openTarget: tabsFor,
      newTab: tabsFor,
      listTabs: () => new Promise<TabInfo[]>(() => {}),
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')

    await user.click(taskButton('task A'))
    await screen.findByRole('tab', { name: 'task A tab' })
    hold.task = 'task A'
    hold.gate = deferred()
    await user.click(screen.getByRole('button', { name: 'New shell tab' }))
    await user.click(taskButton('task B'))
    expect(await screen.findByRole('tab', { name: 'task B tab' })).toBeInTheDocument()

    hold.gate.resolve()
    await act(async () => {
      await hold.gate?.promise
    })
    expect(screen.queryByRole('tab', { name: 'task A tab' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'task B tab' })).toBeInTheDocument()
  })

  it('ignores a listTabs response that arrives after another target was selected', async () => {
    const user = userEvent.setup()
    const holdList: Hold = {}
    const api: MeManagerApi = repoApi({
      openTarget: perTaskTabs(() => api, {}),
      listTabs: perTaskTabs(() => api, holdList),
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')

    holdList.task = 'task A'
    holdList.gate = deferred()
    await user.click(taskButton('task A')) // the refresh after opening calls listTabs(A), which is held
    await screen.findByRole('tab', { name: 'task A tab' })
    await user.click(taskButton('task B'))
    expect(await screen.findByRole('tab', { name: 'task B tab' })).toBeInTheDocument()

    holdList.gate.resolve()
    await act(async () => {
      await holdList.gate?.promise
    })
    expect(screen.queryByRole('tab', { name: 'task A tab' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'task B tab' })).toBeInTheDocument()
  })

  it('keeps a selection made while a task was being removed', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const base = repoApi()
    const api: MeManagerApi = {
      ...base,
      removeTask: async (...args) => {
        await gate.promise
        return base.removeTask(...args)
      },
    }
    render(<App api={api} />)
    await createRepoAndTask(user, 'task B', 'task T') // task T ends up selected
    expect(await screen.findByText('my-api › task T')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove task task T' }))
    await user.click(taskButton('task B'))
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()

    gate.resolve()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove task task T' })).not.toBeInTheDocument())
    expect(screen.getByText('my-api › task B')).toBeInTheDocument()
  })

  it('shows the warning when unsaved work could not be checked, and still removes', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      checkTaskRemoval: async () => ({ uncommittedFiles: [], unpushedCommits: [], warning: 'repo missing' }),
    })
    const removeTask = vi.spyOn(api, 'removeTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Remove task fix login bug' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('repo missing')
    await user.click(within(dialog).getByRole('button', { name: 'Remove anyway' }))
    expect(removeTask).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows backend errors as toasts', async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      createTheme: async () => {
        throw new Error('Error invoking remote method \'api:createTheme\': Error: A theme named "X" already exists')
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

describe('App side panel', () => {
  const togglePanel = (user: UserEvent): Promise<void> =>
    user.click(screen.getByRole('button', { name: 'Toggle files panel' }))
  const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Files panel' })
  const codeText = (): string => document.querySelector('.code-body')?.textContent ?? ''

  it('opens with the toggle button and lists, filters and shows files', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const readFile = vi.spyOn(api, 'readFile')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(screen.queryByRole('complementary', { name: 'Files panel' })).not.toBeInTheDocument()

    await togglePanel(user)
    expect(screen.getByRole('button', { name: 'Toggle files panel' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('separator', { name: 'Resize files panel' })).toHaveAttribute(
      'aria-orientation',
      'vertical',
    )
    expect(await within(panel()).findByRole('button', { name: 'README.md' })).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'package.json' })).toBeInTheDocument()

    await user.type(within(panel()).getByRole('textbox', { name: 'Filter files' }), 'app')
    expect(within(panel()).queryByRole('button', { name: 'README.md' })).not.toBeInTheDocument()
    const app = within(panel()).getByRole('button', { name: /^app\.ts/ })
    await user.click(app)
    expect(readFile).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }), 'src/app.ts')
    await waitFor(() => expect(codeText()).toContain('export function greetAll'))
  })

  it('renders Markdown through MarkdownView, with a Raw toggle', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    await togglePanel(user)
    await user.click(await within(panel()).findByRole('button', { name: 'README.md' }))
    expect(await screen.findByTestId('markdown')).toHaveTextContent('MD:# Demo project')
    await user.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(codeText()).toContain('# Demo project')
  })

  it('hides the Changes tab for a folder target', async () => {
    const user = userEvent.setup()
    const api = createMockApi({ pickDirectory: async () => '/home/me/notes' })
    const listChanges = vi.spyOn(api, 'listChanges')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(await screen.findByRole('button', { name: /📁 notes$/ }))
    await togglePanel(user)
    expect(await within(panel()).findByRole('button', { name: 'README.md' })).toBeInTheDocument()
    expect(within(panel()).getByRole('tab', { name: 'Files' })).toBeInTheDocument()
    expect(within(panel()).queryByRole('tab', { name: /Changes/ })).not.toBeInTheDocument()
    expect(listChanges).not.toHaveBeenCalled()
  })

  it('shows a diff in Changes and opens the file in Files', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const fileDiff = vi.spyOn(api, 'fileDiff')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await togglePanel(user)
    await user.click(await within(panel()).findByRole('tab', { name: 'Changes 4' }))
    await user.click(within(panel()).getByRole('button', { name: /src\/app\.ts/ }))
    expect(fileDiff).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }), 'src/app.ts')
    expect(await screen.findByTestId('diff')).toHaveTextContent('@@ -1,3 +1,5 @@')

    await user.click(within(panel()).getByRole('button', { name: 'Open file' }))
    expect(within(panel()).getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByRole('button', { name: /^app\.ts/ })).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(codeText()).toContain('greetAll'))
  })

  it('keeps panel state per target', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user, 'task A', 'task B')

    await user.click(taskButton('task A'))
    await togglePanel(user)
    await user.click(await within(panel()).findByRole('button', { name: 'package.json' }))
    await waitFor(() => expect(codeText()).toContain('demo-project'))

    await user.click(taskButton('task B'))
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Files panel' })).not.toBeInTheDocument()

    await user.click(taskButton('task A'))
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
    expect(await within(panel()).findByRole('button', { name: 'package.json' })).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(codeText()).toContain('demo-project'))
  })

  it('toggles with Ctrl+Shift+E and closes with ✕', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
    expect(panel()).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('complementary', { name: 'Files panel' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true })
    await user.click(within(panel()).getByRole('button', { name: 'Close files panel' }))
    expect(screen.queryByRole('complementary', { name: 'Files panel' })).not.toBeInTheDocument()
  })

  it('resizes the panel from the keyboard', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    await togglePanel(user)
    const splitter = screen.getByRole('separator', { name: 'Resize files panel' })
    expect(splitter).toHaveAttribute('aria-valuenow', '40')
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
    expect(splitter).toHaveAttribute('aria-valuenow', '42')
    expect(panel().style.getPropertyValue('--panel-width')).toBe('42.00%')
  })

  it('shows the missing-folder message instead of the panel body', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    render(<App api={api} />)
    await createRepoAndTask(user)
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    const taskId = repo.kind === 'repo' ? repo.tasks[0].id : ''
    api.getStatus = async () => ({ running: [], missing: [taskId] })
    await togglePanel(user)
    await user.click(taskButton('fix login bug')) // re-open triggers a status refresh
    expect(await within(panel()).findByText("⚠ This task's folder is missing.")).toBeInTheDocument()
  })
})

describe('App command palette', () => {
  const openPalette = async (): Promise<HTMLElement> => {
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    return screen.findByRole('dialog', { name: 'Command palette' })
  }
  const search = (): HTMLElement => screen.getByRole('combobox', { name: 'Search tasks, files and actions' })
  const optionNames = (dialog: HTMLElement): (string | null)[] =>
    within(dialog)
      .getAllByRole('option')
      .map((o) => o.getAttribute('aria-label'))

  it('opens with Ctrl+Shift+P, focuses the search, and closes with Esc or Ctrl+Shift+P', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user, 'task A', 'task B')
    const dialog = await openPalette()
    expect(search()).toHaveFocus()
    expect(within(dialog).getByRole('listbox')).toBeInTheDocument()
    expect(optionNames(dialog)).toEqual(
      expect.arrayContaining(['Client X › my-api › task A', 'Client X › my-api › task B', 'New theme']),
    )
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()

    await openPalette()
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })

  it('leaves Ctrl+K and Ctrl+/ to the terminal on Linux', async () => {
    render(<App api={repoApi()} />)
    const k = fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const slash = fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    expect(k).toBe(true) // not prevented
    expect(slash).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('filters tasks fuzzily', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user, 'fix login bug', 'add tests')
    const dialog = await openPalette()
    await user.type(search(), 'flb')
    expect(optionNames(dialog)[0]).toBe('Client X › my-api › fix login bug')
    expect(optionNames(dialog)).not.toContain('Client X › my-api › add tests')
    expect(within(dialog).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the task picked with Enter', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B') // task B is selected
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    const taskA = repo.kind === 'repo' ? repo.tasks[0] : undefined
    openTarget.mockClear()

    await openPalette()
    await user.type(search(), 'task a')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(openTarget).toHaveBeenCalledWith({ themeId: state.themes[0].id, itemId: repo.id, taskId: taskA?.id })
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
  })

  it("opens one of the selected task's files in the side panel", async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const listFiles = vi.spyOn(api, 'listFiles')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const dialog = await openPalette()
    await user.type(search(), 'srcapp')
    const option = await within(dialog).findByRole('option', { name: 'src/app.ts' })
    expect(listFiles).toHaveBeenCalledTimes(1) // fetched once when the palette opened, then cached
    await user.click(option)

    const panel = screen.getByRole('complementary', { name: 'Files panel' })
    expect(within(panel).getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(await within(panel).findByRole('button', { name: /^app\.ts/ })).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(document.querySelector('.code-body')?.textContent).toContain('greetAll'))
  })

  it('runs actions, moving with the arrow keys', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const newTab = vi.spyOn(api, 'newTab')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const dialog = await openPalette()
    await user.type(search(), 'shell')
    expect(optionNames(dialog)[0]).toBe('New shell tab')
    await user.keyboard('{Enter}')
    expect(newTab).toHaveBeenCalledTimes(1)

    await openPalette()
    await user.type(search(), 'keyboard shortcuts')
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
  })

  it('leaves out target actions when nothing is selected', async () => {
    render(<App api={createMockApi()} />)
    const dialog = await openPalette()
    expect(optionNames(dialog)).toEqual(['New theme', 'Show keyboard shortcuts'])
  })
})

describe('App keyboard shortcuts', () => {
  const press = (key: string, over: Partial<KeyboardEventInit> = {}, target: Element | Window = window): void => {
    fireEvent.keyDown(target, { key, ctrlKey: true, ...over })
  }
  const twoTabs: TabInfo[] = [
    { index: 0, name: 'claude', active: true },
    { index: 1, name: 'bash', active: false },
  ]

  it('selects the Nth visible task with Ctrl+1..9, skipping collapsed groups', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B') // task B is selected
    press('1')
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
    press('2')
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()

    openTarget.mockClear()
    press('2') // already selected: nothing to do
    press('3') // there is no third target
    expect(openTarget).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /📦 my-api$/ })) // collapse the repo
    press('1')
    expect(openTarget).not.toHaveBeenCalled()
    expect(screen.getByText('my-api › task B')).toBeInTheDocument()
  })

  it('opens a new shell tab with Ctrl+Shift+T, but not with Ctrl+T', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const newTab = vi.spyOn(api, 'newTab')
    render(<App api={api} />)
    await createRepoAndTask(user)
    press('t')
    expect(newTab).not.toHaveBeenCalled()
    press('T', { shiftKey: true })
    expect(newTab).toHaveBeenCalledTimes(1)
    expect(newTab).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }))
  })

  it('switches tabs with Ctrl+Shift+[ / ] and closes the active one with Ctrl+Shift+W', async () => {
    const user = userEvent.setup()
    const api = repoApi({ openTarget: async () => twoTabs, listTabs: async () => twoTabs })
    const selectTab = vi.spyOn(api, 'selectTab')
    const closeTab = vi.spyOn(api, 'closeTab')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await screen.findByRole('tab', { name: 'bash' })
    press('}', { shiftKey: true, code: 'BracketRight' })
    expect(selectTab).toHaveBeenLastCalledWith(expect.anything(), 1)
    press('{', { shiftKey: true, code: 'BracketLeft' }) // wraps around from the first tab
    expect(selectTab).toHaveBeenLastCalledWith(expect.anything(), 1)
    press('W', { shiftKey: true })
    expect(closeTab).toHaveBeenCalledWith(expect.anything(), 0)
  })

  it('shows the shortcut help with Ctrl+Shift+/ and closes it with Esc', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    press('?', { shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    for (const keys of ['Ctrl+Shift+P', 'Ctrl+Shift+/', 'Ctrl+Shift+E', 'Ctrl+1…9', 'Ctrl+Shift+T', 'Ctrl+Shift+W'])
      expect(within(help).getByText(keys)).toBeInTheDocument()
    expect(within(help).getByText('New shell tab')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()

    press('?', { shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    press('P', { shiftKey: true }) // the palette replaces the help
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    press('?', { shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('ignores task and tab shortcuts while typing in a text field or with an overlay open', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const newTab = vi.spyOn(api, 'newTab')
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    openTarget.mockClear()
    await user.click(screen.getByRole('button', { name: 'Toggle files panel' }))
    const filter = await screen.findByRole('textbox', { name: 'Filter files' })
    press('T', { shiftKey: true }, filter)
    press('1', {}, filter)
    expect(newTab).not.toHaveBeenCalled()
    expect(openTarget).not.toHaveBeenCalled()

    press('P', { shiftKey: true }, filter) // the palette works anywhere
    const search = screen.getByRole('combobox', { name: 'Search tasks, files and actions' })
    press('T', { shiftKey: true }, search)
    press('E', { shiftKey: true }, search)
    expect(newTab).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary', { name: 'Files panel' })).toBeInTheDocument()
  })

  it("acts on shortcuts typed in the terminal's own textarea", async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const newTab = vi.spyOn(api, 'newTab')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const textarea = document.createElement('textarea')
    xterm.append(textarea)
    screen.getByTestId('terminal').append(xterm)
    press('T', { shiftKey: true }, textarea)
    expect(newTab).toHaveBeenCalledTimes(1)
  })
})

describe('App sidebar filter', () => {
  const filterBox = (): HTMLElement => screen.getByRole('textbox', { name: 'Filter sidebar' })
  const hasTask = (name: string): boolean => screen.queryByRole('button', { name: `Remove task ${name}` }) !== null

  async function setup(user: UserEvent, api = repoApi()): Promise<void> {
    render(<App api={api} />)
    await createRepoAndTask(user, 'fix login bug', 'add tests')
    await createTheme(user, 'Personal')
  }

  it('narrows the tree to matches and their ancestors, and Esc clears it', async () => {
    const user = userEvent.setup()
    await setup(user)
    await user.type(filterBox(), 'LOGIN')
    expect(hasTask('fix login bug')).toBe(true)
    expect(hasTask('add tests')).toBe(false)
    expect(screen.getByRole('button', { name: /📦 my-api$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove theme Client X' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove theme Personal' })).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(filterBox()).toHaveValue('')
    expect(hasTask('add tests')).toBe(true)
    expect(screen.getByRole('button', { name: 'Remove theme Personal' })).toBeInTheDocument()
  })

  it('expands collapsed groups while filtering', async () => {
    const user = userEvent.setup()
    await setup(user)
    await user.click(screen.getByRole('button', { name: /📦 my-api$/ }))
    expect(hasTask('add tests')).toBe(false)
    await user.type(filterBox(), 'tests')
    expect(hasTask('add tests')).toBe(true)
    await user.keyboard('{Escape}')
    expect(hasTask('add tests')).toBe(false) // collapsed again once the filter is gone
  })

  it('says when nothing matches', async () => {
    const user = userEvent.setup()
    await setup(user)
    await user.type(filterBox(), 'zzz')
    expect(screen.getByText('No matches')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove theme Client X' })).not.toBeInTheDocument()
  })

  it('is focused with Ctrl+Shift+F, and Ctrl+1 counts only the filtered entries', async () => {
    const user = userEvent.setup()
    await setup(user)
    await user.click(taskButton('fix login bug'))
    expect(await screen.findByText('my-api › fix login bug')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(filterBox()).toHaveFocus()
    await user.type(filterBox(), 'tests')
    fireEvent.keyDown(filterBox(), { key: '1', ctrlKey: true }) // ignored while typing in the filter
    expect(screen.getByText('my-api › fix login bug')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '1', ctrlKey: true })
    expect(await screen.findByText('my-api › add tests')).toBeInTheDocument()
  })

  it('lists Ctrl+Shift+F in the shortcut help', async () => {
    render(<App api={repoApi()} />)
    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(help).getByText('Ctrl+Shift+F')).toBeInTheDocument()
    expect(within(help).getByText('Filter the sidebar')).toBeInTheDocument()
  })
})

describe('App rename', () => {
  const nameBox = (): HTMLElement => screen.getByRole('textbox', { name: 'Name' })

  it('renames a task from its row; the header updates and the branch stays', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const renameTask = vi.spyOn(api, 'renameTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(await screen.findByText('my-api › fix login bug')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Rename task fix login bug' }))
    const dialog = screen.getByRole('dialog', { name: 'Rename task' })
    expect(nameBox()).toHaveValue('fix login bug')
    expect(nameBox()).toHaveAccessibleDescription('The branch and folder keep their original name.')
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled() // unchanged
    await user.clear(nameBox())
    await user.type(nameBox(), 'Fix the login flow')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

    expect(await screen.findByText('my-api › Fix the login flow')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/branch: claude\/client-x\/fix-login-bug/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove task Fix the login flow' })).toBeInTheDocument()
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    expect(renameTask).toHaveBeenCalledWith(
      state.themes[0].id,
      repo.id,
      repo.kind === 'repo' ? repo.tasks[0].id : '',
      'Fix the login flow',
    )
  })

  it('renames a theme', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Rename theme Client X' }))
    expect(screen.getByRole('dialog', { name: 'Rename theme' })).toHaveTextContent(
      'The branch and folder keep their original name.',
    )
    await user.clear(nameBox())
    await user.type(nameBox(), 'Acme{Enter}')
    expect(await screen.findByRole('button', { name: 'Remove theme Acme' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove theme Client X' })).not.toBeInTheDocument()
  })

  it('keeps the dialog open and shows the error for a duplicate name', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user, 'task A', 'task B')
    await user.click(screen.getByRole('button', { name: 'Rename task task B' }))
    await user.clear(nameBox())
    await user.type(nameBox(), 'TASK A{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('A task named "TASK A" already exists')
    expect(screen.getByRole('dialog', { name: 'Rename task' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Rename task' })).not.toBeInTheDocument()
    expect(screen.getByText('my-api › task B')).toBeInTheDocument()
  })

  it('renames the current task from the palette', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    await user.type(await screen.findByRole('combobox'), 'rename current')
    await user.keyboard('{Enter}')
    expect(nameBox()).toHaveValue('fix login bug')
    await user.clear(nameBox())
    await user.type(nameBox(), 'login{Enter}')
    expect(await screen.findByText('my-api › login')).toBeInTheDocument()
  })
})
