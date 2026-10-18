import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { App, ZOOM_SAVE_MS } from './App'
import { createMockApi } from './api/mockApi'
import type { MeManagerApi, TabInfo, Target, TaskGitStatus, UsageReport, UsageSummary } from '../../shared/types'
import { emptyUsageSummary } from '../../shared/usage'

vi.mock('./components/TerminalView', () => ({
  TerminalView: ({ fontSize }: { fontSize: number }) => <div data-testid="terminal" data-font-size={fontSize} />,
}))
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
    api.getStatus = async () => ({ running: [], missing: [taskId], activity: {} })
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
    expect(optionNames(dialog)).toEqual(['New theme', 'Show usage', 'Open settings', 'Show keyboard shortcuts'])
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

describe('App task notes', () => {
  const notesBox = (): HTMLElement => screen.getByRole('textbox', { name: 'Notes' })
  const header = (): HTMLElement => screen.getByRole('banner')

  it('adds notes with Ctrl+Enter; the header shows them collapsed, a click expands them', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const setTaskNotes = vi.spyOn(api, 'setTaskNotes')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(within(header()).getByRole('button', { name: 'Edit notes' }))
    expect(screen.getByRole('dialog', { name: 'Notes for fix login bug' })).toBeInTheDocument()
    expect(notesBox()).toHaveValue('')
    expect(notesBox()).toHaveAttribute('maxlength', '2000')
    await user.type(notesBox(), 'Waiting on the API team{Shift>}{Enter}{/Shift}then ship')
    expect(screen.getByText('33 / 2000')).toBeInTheDocument()
    await user.keyboard('{Control>}{Enter}{/Control}')

    expect(setTaskNotes).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'Waiting on the API team\nthen ship',
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const notes = within(header()).getByRole('button', { name: /Waiting on the API team/ })
    expect(notes).toHaveAttribute('aria-expanded', 'false')
    await user.click(notes)
    expect(notes).toHaveAttribute('aria-expanded', 'true')
    expect(taskButton('fix login bug')).toHaveAttribute('title', 'Waiting on the API team\nthen ship')
  })

  it('edits and clears existing notes, and Cancel keeps them', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    await user.click(within(header()).getByRole('button', { name: 'Edit notes' }))
    await user.type(notesBox(), 'first')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(header()).findByRole('button', { name: 'first' })).toBeInTheDocument()

    await user.click(within(header()).getByRole('button', { name: 'Edit notes' }))
    expect(notesBox()).toHaveValue('first')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled() // unchanged
    await user.type(notesBox(), ' draft')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(within(header()).getByRole('button', { name: 'first' })).toBeInTheDocument()

    await user.click(within(header()).getByRole('button', { name: 'Edit notes' }))
    await user.clear(notesBox())
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(header()).queryByRole('button', { name: 'first' })).not.toBeInTheDocument())
    expect(taskButton('fix login bug')).not.toHaveAttribute('title')
  })

  it('renders notes as plain text, never HTML', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    const html = '<img src=x onerror="alert(1)"><b>bold</b>'
    await user.click(within(header()).getByRole('button', { name: 'Edit notes' }))
    fireEvent.change(notesBox(), { target: { value: html } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const notes = await within(header()).findByRole('button', { name: html })
    expect(notes.textContent).toBe(html)
    expect(header().querySelector('img, b')).toBeNull()
  })

  it('has no notes for folders', async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi({ pickDirectory: async () => '/home/me/notes' })} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(await screen.findByRole('button', { name: /📁 notes$/ }))
    expect(within(header()).queryByRole('button', { name: 'Edit notes' })).not.toBeInTheDocument()
  })
})

describe('App copy actions', () => {
  /** Installed after userEvent.setup(), which puts its own clipboard stub on navigator. */
  type WriteText = (text: string) => Promise<void>
  function mockClipboard(writeText = vi.fn<WriteText>(async () => {})): typeof writeText {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }
  const header = (): HTMLElement => screen.getByRole('banner')

  it("copies the task's branch, worktree path and attach command, and confirms", async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    render(<App api={repoApi({ getTmuxSocket: async () => 'test-sock' })} />)
    await createRepoAndTask(user)
    const copy = within(header()).getByRole('group', { name: 'Copy' })

    await user.click(within(copy).getByRole('button', { name: 'Copy branch name' }))
    expect(writeText).toHaveBeenLastCalledWith('claude/client-x/fix-login-bug')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied branch name')

    await user.click(within(copy).getByRole('button', { name: 'Copy worktree path' }))
    expect(writeText).toHaveBeenLastCalledWith('/home/demo/.me-manager/worktrees/client-x/my-api/fix-login-bug')

    await user.click(await within(copy).findByRole('button', { name: 'Copy attach command' }))
    expect(writeText).toHaveBeenLastCalledWith('tmux -L test-sock attach -t mmt_client-x_my-api_fix-login-bug')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied attach command')
    expect(screen.getAllByRole('status')).toHaveLength(1) // confirmations replace each other
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("copies a folder's path and attach command", async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    render(<App api={createMockApi({ pickDirectory: async () => '/home/me/notes' })} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(await screen.findByRole('button', { name: /📁 notes$/ }))
    expect(within(header()).queryByRole('button', { name: 'Copy branch name' })).not.toBeInTheDocument()
    await user.click(within(header()).getByRole('button', { name: 'Copy folder path' }))
    expect(writeText).toHaveBeenLastCalledWith('/home/me/notes')
    await user.click(within(header()).getByRole('button', { name: 'Copy attach command' }))
    expect(writeText).toHaveBeenLastCalledWith('tmux -L me-manager attach -t mmf_client-x_notes')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied attach command')
  })

  it('copies from the palette', async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    for (const [label, text] of [
      ['Copy branch name', 'claude/client-x/fix-login-bug'],
      ['Copy worktree path', '/home/demo/.me-manager/worktrees/client-x/my-api/fix-login-bug'],
      ['Copy attach command', 'tmux -L me-manager attach -t mmt_client-x_my-api_fix-login-bug'],
    ]) {
      fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
      await user.type(await screen.findByRole('combobox'), label)
      expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(label)
      await user.keyboard('{Enter}')
      expect(writeText).toHaveBeenLastCalledWith(text)
    }
    expect(await screen.findByRole('status')).toHaveTextContent('Copied attach command')
  })

  it('shows an error when the clipboard refuses', async () => {
    const user = userEvent.setup()
    mockClipboard(vi.fn<WriteText>(async () => Promise.reject(new Error('denied'))))
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    await user.click(within(header()).getByRole('button', { name: 'Copy branch name' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy the branch name to the clipboard')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('App settings', () => {
  const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Settings' })
  const field = (name: string): HTMLElement => within(dialog()).getByLabelText(name)

  it('opens from the sidebar button, shows the current settings and saves edits', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    await api.updateSettings({ claudeArgs: ['--model', 'opus'], pollIntervalMs: 5000 })
    const updateSettings = vi.spyOn(api, 'updateSettings')
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(field('Extra claude arguments')).toHaveValue('--model opus')
    expect(field('Extra claude arguments')).toHaveFocus()
    expect(field('Refresh interval')).toHaveValue(5)
    expect(field('Terminal font size')).toHaveValue(13)
    expect(within(dialog()).getByRole('checkbox', { name: 'Desktop notifications' })).toBeChecked()
    expect(within(dialog()).getByText(/Applies to sessions started after saving/)).toBeInTheDocument()

    await user.clear(field('Extra claude arguments'))
    await user.type(field('Extra claude arguments'), `--model sonnet --append-system-prompt "be brief"`)
    await user.type(field('Editor command'), 'code -n')
    await user.clear(field('Terminal font size'))
    await user.type(field('Terminal font size'), '15')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Desktop notifications' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))

    expect(updateSettings).toHaveBeenLastCalledWith({
      claudeArgs: ['--model', 'sonnet', '--append-system-prompt', 'be brief'],
      editorCommand: 'code -n',
      pollIntervalMs: 5000,
      terminalFontSize: 15,
      notifications: false,
      remoteControl: true,
      skipPermissions: true,
      updateStrategy: 'rebase',
    })
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
    expect(await screen.findByText('Settings saved')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(field('Extra claude arguments')).toHaveValue("--model sonnet --append-system-prompt 'be brief'")
    expect(field('Terminal font size')).toHaveValue(15)
  })

  it('shows inline errors and keeps Save off until the fields are valid', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const updateSettings = vi.spyOn(api, 'updateSettings')
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const save = within(dialog()).getByRole('button', { name: 'Save' })

    await user.type(field('Extra claude arguments'), `--append-system-prompt 'oops`)
    expect(field('Extra claude arguments')).toHaveAttribute('aria-invalid', 'true')
    expect(field('Extra claude arguments')).toHaveAccessibleDescription(/single quote.*not closed/)
    await user.clear(field('Refresh interval'))
    await user.type(field('Refresh interval'), '0.2')
    expect(within(dialog()).getByText('Enter a number of seconds from 1 to 30.')).toBeInTheDocument()
    await user.clear(field('Terminal font size'))
    await user.type(field('Terminal font size'), '99')
    expect(within(dialog()).getByText('Enter a whole number from 8 to 32.')).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(updateSettings).not.toHaveBeenCalled()

    await user.type(field('Extra claude arguments'), `'`)
    await user.clear(field('Refresh interval'))
    await user.type(field('Refresh interval'), '2')
    await user.clear(field('Terminal font size'))
    await user.type(field('Terminal font size'), '14')
    expect(field('Extra claude arguments')).toHaveAttribute('aria-invalid', 'false')
    expect(save).toBeEnabled()
    await user.click(save)
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ claudeArgs: ['--append-system-prompt', 'oops'], pollIntervalMs: 2000 }),
    )
  })

  it('opens with Ctrl+, and from the palette; Cancel and Esc close without saving', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const updateSettings = vi.spyOn(api, 'updateSettings')
    render(<App api={api} />)
    const comma = fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(comma).toBe(false) // handled, so it never reaches the terminal
    await user.type(field('Editor command'), 'subl')
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    await user.type(screen.getByRole('combobox', { name: 'Search tasks, files and actions' }), 'settings')
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    expect(within(palette).getByRole('option', { name: 'Open settings' })).toHaveTextContent('Ctrl+,')
    await user.keyboard('{Enter}')
    expect(field('Editor command')).toHaveValue('') // the cancelled edit is gone
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the error when saving fails', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi({ updateSettings: async () => Promise.reject(new Error('disk full')) })} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('disk full')).toBeInTheDocument()
    expect(dialog()).toBeInTheDocument()
  })

  it('polls status at the saved interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = repoApi()
      await api.updateSettings({ pollIntervalMs: 10_000 })
      const getStatus = vi.spyOn(api, 'getStatus')
      render(<App api={api} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      getStatus.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000)
      })
      expect(getStatus).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      expect(getStatus).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists Ctrl+, in the shortcut help', async () => {
    render(<App api={repoApi()} />)
    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(help).getByText('Ctrl+,')).toBeInTheDocument()
    expect(within(help).getByText('Settings')).toBeInTheDocument()
  })
})

describe('App open in editor / file manager', () => {
  it('opens the selected task from the header buttons and confirms', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openInEditor = vi.spyOn(api, 'openInEditor')
    const openInFileManager = vi.spyOn(api, 'openInFileManager')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const target = expect.objectContaining({ taskId: expect.any(String) })
    await user.click(screen.getByRole('button', { name: 'Open in editor' }))
    expect(openInEditor).toHaveBeenCalledWith(target)
    expect(await screen.findByText('Opening in the editor…')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reveal in file manager' }))
    expect(openInFileManager).toHaveBeenCalledWith(target)
    expect(await screen.findByText('Opening the file manager…')).toBeInTheDocument()
  })

  it('opens a folder too, with Ctrl+Shift+O and from the palette', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openInEditor = vi.spyOn(api, 'openInEditor')
    const openInFileManager = vi.spyOn(api, 'openInFileManager')
    render(<App api={api} />)
    await createTheme(user, 'Notes')
    await user.click(screen.getByRole('button', { name: 'Add folder to Notes' }))
    await user.click(await screen.findByRole('button', { name: /📁 my-api$/ }))
    const state = await api.getState()
    const folder = { themeId: state.themes[0].id, itemId: state.themes[0].items[0].id }

    expect(fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(openInEditor).toHaveBeenCalledWith(folder)
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true }) // plain Ctrl+O stays with the terminal
    expect(openInEditor).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    expect(within(palette).getByRole('option', { name: 'Open in editor' })).toHaveTextContent('Ctrl+Shift+O')
    await user.type(screen.getByRole('combobox', { name: 'Search tasks, files and actions' }), 'reveal')
    await user.keyboard('{Enter}')
    expect(openInFileManager).toHaveBeenCalledWith(folder)
  })

  it('shows why the editor could not open', async () => {
    const user = userEvent.setup()
    render(
      <App
        api={repoApi({ openInEditor: async () => Promise.reject(new Error('No editor found — set one in Settings')) })}
      />,
    )
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Open in editor' }))
    expect(await screen.findByText('No editor found — set one in Settings')).toBeInTheDocument()
    expect(screen.queryByText('Opening in the editor…')).not.toBeInTheDocument()
  })

  it('does nothing with nothing selected, and lists Ctrl+Shift+O in the help', async () => {
    const api = repoApi()
    const openInEditor = vi.spyOn(api, 'openInEditor')
    render(<App api={api} />)
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true })
    expect(openInEditor).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(help).getByText('Ctrl+Shift+O')).toBeInTheDocument()
  })

  it('flags a terminal editor in Settings', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    await user.type(within(dialog).getByLabelText('Editor command'), 'vim')
    expect(within(dialog).getByText(/vim runs in a terminal/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

describe('App terminal zoom', () => {
  const press = (key: string, over: Partial<KeyboardEventInit> = {}): boolean =>
    fireEvent.keyDown(window, { key, ctrlKey: true, ...over })
  const fontSize = (): string | null => screen.getByTestId('terminal').getAttribute('data-font-size')
  const wait = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  async function setup(api = repoApi()): Promise<MockInstance<MeManagerApi['updateSettings']>> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const updateSettings = vi.spyOn(api, 'updateSettings')
    render(<App api={api} />)
    await createRepoAndTask(user)
    updateSettings.mockClear()
    return updateSettings
  }

  it('zooms in with Ctrl+= and Ctrl++, out with Ctrl+-, resets with Ctrl+0, and saves once, debounced', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const updateSettings = await setup()
      expect(fontSize()).toBe('13')
      expect(press('=')).toBe(false) // handled: never reaches the terminal
      press('+', { shiftKey: true, code: 'Equal' })
      expect(fontSize()).toBe('15')
      expect(screen.getByText('Font size 15')).toBeInTheDocument()
      press('-')
      expect(fontSize()).toBe('14')
      expect(screen.getByText('Font size 14')).toBeInTheDocument()
      expect(updateSettings).not.toHaveBeenCalled()
      await wait(ZOOM_SAVE_MS + 50)
      expect(updateSettings).toHaveBeenCalledTimes(1)
      expect(updateSettings).toHaveBeenCalledWith({ terminalFontSize: 14 })

      press('0')
      expect(fontSize()).toBe('13')
      await wait(ZOOM_SAVE_MS + 50)
      expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 13 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at the largest size without saving past it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = repoApi()
      await api.updateSettings({ terminalFontSize: 31 })
      const updateSettings = await setup(api)
      expect(fontSize()).toBe('31')
      press('=')
      press('=')
      press('=')
      expect(fontSize()).toBe('32')
      expect(screen.getByText('Font size 32')).toBeInTheDocument()
      await wait(ZOOM_SAVE_MS + 50)
      expect(updateSettings.mock.calls).toEqual([[{ terminalFontSize: 32 }]])
      press('=') // already at the limit: says so, saves nothing
      expect(screen.getByText('Font size 32')).toBeInTheDocument()
      await wait(ZOOM_SAVE_MS + 50)
      expect(updateSettings).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at the smallest size', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = repoApi()
      await api.updateSettings({ terminalFontSize: 9 })
      const updateSettings = await setup(api)
      for (let i = 0; i < 4; i++) press('-')
      expect(fontSize()).toBe('8')
      expect(screen.getByText('Font size 8')).toBeInTheDocument()
      await wait(ZOOM_SAVE_MS + 50)
      expect(updateSettings.mock.calls).toEqual([[{ terminalFontSize: 8 }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists the zoom keys in the shortcut help', async () => {
    render(<App api={repoApi()} />)
    press('?', { shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    for (const keys of ['Ctrl+=', 'Ctrl++', 'Ctrl+-', 'Ctrl+0'])
      expect(within(help).getByText(keys)).toBeInTheDocument()
  })
})

describe('App usage', () => {
  /** A summary where every period has `cost` dollars of opus output (plus extra fields), scaled down for shorter periods. */
  const usageOf = (cost: number, extra: Partial<UsageSummary['all']> = {}): UsageSummary => {
    const s = emptyUsageSummary()
    const shares = { today: 0.1, week: 0.5, month: 0.8, all: 1 } as const
    for (const p of ['today', 'week', 'month', 'all'] as const) {
      const c = cost * shares[p]
      s[p] = {
        ...s[p],
        cost: c,
        output: Math.round((c / 20) * 1e6),
        messages: c > 0 ? 3 : 0,
        sessions: c > 0 ? 1 : 0,
        models:
          c > 0
            ? [
                {
                  ...s[p],
                  model: 'claude-opus-5-5',
                  priced: true,
                  cost: c,
                  output: Math.round((c / 20) * 1e6),
                  messages: 3,
                  sessions: 1,
                },
              ]
            : [],
        ...extra,
      }
    }
    return s
  }

  /** The mock API, with fixed usage per task name and a report built from the current state. */
  function usageApi(costs: Record<string, number>, extra: Partial<MeManagerApi> = {}): MeManagerApi {
    const api: MeManagerApi = repoApi({
      getUsage: async (target) => usageOf(costs[(await nameOf(target)) ?? ''] ?? 0),
      getUsageReport: async (): Promise<UsageReport> => {
        const state = await api.getState()
        const themes = state.themes.map((theme) => {
          const targets = theme.items.flatMap((item) =>
            item.kind === 'repo'
              ? item.tasks.map((task) => ({
                  target: { themeId: theme.id, itemId: item.id, taskId: task.id },
                  kind: 'task' as const,
                  label: `${item.name} › ${task.name}`,
                  path: task.worktreePath,
                  usage: usageOf(costs[task.name] ?? 0),
                }))
              : [],
          )
          const sum = targets.reduce((n, t) => n + t.usage.all.cost, 0)
          return { themeId: theme.id, name: theme.name, usage: usageOf(sum), targets }
        })
        const total = usageOf(
          Object.values(costs).reduce((a, b) => a + b, 0),
          costs.unpriced ? { unpricedTokens: 5000 } : {},
        )
        if (costs.unpriced)
          for (const p of ['today', 'week', 'month', 'all'] as const)
            total[p].models = [
              ...total[p].models,
              {
                ...emptyUsageSummary()[p],
                model: 'claude-mystery-1',
                priced: false,
                unpricedTokens: 5000,
                input: 5000,
              },
            ]
        return { generatedAt: new Date().toISOString(), total, themes }
      },
      ...extra,
    })
    const nameOf = async (target: Target): Promise<string | undefined> => {
      const repo = (await api.getState()).themes.flatMap((t) => t.items).find((i) => i.id === target.itemId)
      return repo?.kind === 'repo' ? repo.tasks.find((k) => k.id === target.taskId)?.name : undefined
    }
    return api
  }

  const usageDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Claude usage' })

  it("shows the selected task's usage as a header badge, with the periods and token split on hover", async () => {
    const user = userEvent.setup()
    render(<App api={usageApi({ 'fix login bug': 3.42 })} />)
    await createRepoAndTask(user)
    const badge = await screen.findByRole('button', { name: 'Claude usage: $3.42 · 171k tok' })
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(badge).toHaveAttribute('aria-describedby', tip.id)
    expect(within(tip).getByText('Estimated cost at API prices')).toBeInTheDocument()
    for (const [label, cost] of [
      ['Today', '$0.34'],
      ['Last 7 days', '$1.71'],
      ['This month', '$2.74'],
      ['All time', '$3.42'],
    ]) {
      const row = within(tip).getByRole('rowheader', { name: label, hidden: true }).closest('tr')!
      expect(row).toHaveTextContent(cost)
    }
    for (const label of ['Input', 'Output', 'Cache read', 'Cache write'])
      expect(within(tip).getByText(label)).toBeInTheDocument()
    expect(within(tip).getByText(/don't pay per token/)).toBeInTheDocument()
  })

  it('refreshes the badge every 10 seconds, not at the status poll rate', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = usageApi({ 'fix login bug': 1 })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<App api={api} />)
      await createRepoAndTask(user)
      await screen.findByRole('button', { name: /^Claude usage:/ })
      const getUsage = vi.spyOn(api, 'getUsage')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000)
      })
      expect(getUsage).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500)
      })
      expect(getUsage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the usage view from the badge, the sidebar, the palette and Ctrl+Shift+U', async () => {
    const user = userEvent.setup()
    render(<App api={usageApi({ 'fix login bug': 2 })} />)
    await createRepoAndTask(user)

    await user.click(await screen.findByRole('button', { name: /^Claude usage:/ }))
    expect(usageDialog()).toBeInTheDocument()
    fireEvent.keyDown(usageDialog(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Claude usage' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Usage' }))
    expect(usageDialog()).toBeInTheDocument()
    await user.click(within(usageDialog()).getByRole('button', { name: 'Close usage' }))
    expect(screen.queryByRole('dialog', { name: 'Claude usage' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    await user.type(within(palette).getByRole('combobox'), 'show usage')
    await user.keyboard('{Enter}')
    expect(usageDialog()).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'U', ctrlKey: true, shiftKey: true }) // toggles it closed
    expect(screen.queryByRole('dialog', { name: 'Claude usage' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'U', ctrlKey: true, shiftKey: true })
    expect(usageDialog()).toBeInTheDocument()
  })

  it('shows totals, per-theme tables sortable by cost, models and the estimate footnote, per period', async () => {
    const user = userEvent.setup()
    render(<App api={usageApi({ 'task A': 1, 'task B': 4, 'task C': 0 })} />)
    await createRepoAndTask(user, 'task A', 'task B', 'task C')
    await user.click(screen.getByRole('button', { name: 'Usage' }))
    const view = usageDialog()
    const totals = await within(view).findByRole('region', { name: 'Totals' })

    // This month by default.
    expect(within(view).getByRole('button', { name: 'This month' })).toHaveAttribute('aria-pressed', 'true')
    expect(totals).toHaveTextContent('$4.00')
    expect(within(totals).getByText('Estimated cost at API prices')).toBeInTheDocument()
    await user.click(within(view).getByRole('button', { name: 'All time' }))
    expect(totals).toHaveTextContent('$5.00')
    await user.click(within(view).getByRole('button', { name: 'Today' }))
    expect(totals).toHaveTextContent('$0.50')

    const table = within(view).getByRole('table', { name: 'Usage by task and folder' })
    const theme = within(table).getByRole('rowgroup', { name: 'Client X' })
    const rows = (): string[] =>
      within(theme)
        .getAllByRole('button')
        .map((b) => b.textContent ?? '')
    expect(rows()).toEqual(['⎇my-api › task B', '⎇my-api › task A'])
    expect(theme).toHaveTextContent('1 more without usage in this period')
    await user.click(within(table).getByRole('button', { name: /Est. cost/ }))
    expect(rows()).toEqual(['⎇my-api › task A', '⎇my-api › task B'])
    expect(within(table).getByRole('columnheader', { name: /Est. cost/ })).toHaveAttribute('aria-sort', 'ascending')

    const models = within(view).getByRole('table', { name: 'Usage by model' })
    expect(within(models).getByText('claude-opus-5-5')).toBeInTheDocument()
    expect(within(view).queryByRole('note')).not.toBeInTheDocument()
    expect(view).toHaveTextContent(
      "On a Pro/Max subscription you don't pay per token; this is what the same usage would cost on the API.",
    )
  })

  it('notes unpriced models, and opens a task from its row', async () => {
    const user = userEvent.setup()
    const openTarget = vi.fn(async () => [] as TabInfo[])
    render(<App api={usageApi({ 'task A': 1, 'task B': 2, unpriced: 0.000001 }, { openTarget })} />)
    await createRepoAndTask(user, 'task A', 'task B')
    await user.click(screen.getByRole('button', { name: 'Usage' }))
    const note = await within(usageDialog()).findByRole('note')
    expect(note).toHaveTextContent('Unpriced models: claude-mystery-1.')
    expect(within(usageDialog()).getByText('unpriced')).toBeInTheDocument()

    openTarget.mockClear()
    await user.click(within(usageDialog()).getByRole('button', { name: 'my-api › task A' }))
    expect(screen.queryByRole('dialog', { name: 'Claude usage' })).not.toBeInTheDocument()
    expect(openTarget).toHaveBeenCalledTimes(1)
    expect(screen.getByText('my-api › task A')).toBeInTheDocument()
  })

  it('lists Ctrl+Shift+U in the shortcut help', async () => {
    render(<App api={repoApi()} />)
    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(help).getByText('Ctrl+Shift+U')).toBeInTheDocument()
    expect(within(help).getByText('Claude usage and cost')).toBeInTheDocument()
  })
})

describe('App git status', () => {
  const status = (ahead: number, uncommitted = 0): TaskGitStatus => ({
    ahead,
    behind: 0,
    uncommitted,
    branch: 'claude/client-x/fix-login-bug',
    lastCommit: { sha: 'abc1234', subject: 'Fix the redirect', relativeDate: '5 minutes ago' },
  })

  it('shows badges for visible tasks and the git line for the selected one', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const getGitStatus = vi.fn(async (targets: Target[]) =>
      Object.fromEntries(targets.map((t) => [t.taskId!, status(2, 1)])),
    )
    api.getGitStatus = getGitStatus
    render(<App api={api} />)
    await createRepoAndTask(user)
    const sidebar = within(screen.getByRole('navigation'))
    expect(await sidebar.findByTitle('2 commits ahead of origin/main')).toHaveTextContent('↑2')
    expect(sidebar.getByTitle('1 uncommitted file')).toHaveTextContent('●1')
    const line = screen.getByLabelText('Git status')
    expect(line).toHaveTextContent('↑2 ↓0 vs origin/main')
    expect(line).toHaveTextContent('abc1234 Fix the redirect')
  })

  it('asks only for visible tasks, plus the selected one', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const getGitStatus = vi.fn<MeManagerApi['getGitStatus']>(async () => ({}))
    api.getGitStatus = getGitStatus
    render(<App api={api} />)
    await createRepoAndTask(user, 'one', 'two') // "two" is selected (opened after creation)
    await waitFor(() => expect(getGitStatus.mock.lastCall?.[0]).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /^▼ 📦 my-api$/ }))
    await waitFor(() => expect(getGitStatus.mock.lastCall?.[0]).toHaveLength(1))
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    expect(getGitStatus.mock.lastCall?.[0][0].taskId).toBe(repo.kind === 'repo' ? repo.tasks[1].id : '')
  })
})

describe('App Claude activity', () => {
  it('shows the selected session state in the header and the dot in the sidebar', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    render(<App api={api} />)
    await createRepoAndTask(user)
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    const taskId = repo.kind === 'repo' ? repo.tasks[0].id : ''
    api.getStatus = async () => ({ running: [taskId], missing: [], activity: { [taskId]: 'waiting' } })
    await user.click(taskButton('fix login bug')) // re-open triggers a status refresh
    expect(await screen.findByLabelText('Session: Waiting for you')).toBeInTheDocument()
    expect(taskButton('fix login bug').querySelector('.dot')).toHaveClass('running', 'waiting')
  })
})

describe('App notification clicks', () => {
  it('selects the target main asks for, expanding its collapsed repo', async () => {
    const user = userEvent.setup()
    let selectTarget: (target: Target) => void = () => {}
    const unsubscribe = vi.fn()
    const api = repoApi({
      onSelectTarget: (cb) => {
        selectTarget = cb
        return unsubscribe
      },
    })
    const openTarget = vi.spyOn(api, 'openTarget')
    const { unmount } = render(<App api={api} />)
    await createRepoAndTask(user, 'one', 'two') // "two" is selected
    await user.click(screen.getByRole('button', { name: /^▼ 📦 my-api$/ }))
    expect(screen.queryByRole('button', { name: 'Remove task one' })).not.toBeInTheDocument()
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    const one = { themeId: state.themes[0].id, itemId: repo.id, taskId: repo.kind === 'repo' ? repo.tasks[0].id : '' }
    openTarget.mockClear()
    act(() => selectTarget(one))
    await waitFor(() => expect(openTarget).toHaveBeenCalledWith(one))
    expect(await screen.findByRole('button', { name: 'Remove task one' })).toBeInTheDocument()
    expect(screen.getByText('my-api › one')).toBeInTheDocument()
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('App new task options', () => {
  const openNewTask = async (user: UserEvent): Promise<HTMLElement> => {
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
    await user.click(await screen.findByRole('button', { name: 'New task in my-api' }))
    return screen.getByRole('dialog', { name: 'New task in my-api' })
  }

  it('starts from the chosen base branch with an initial prompt, and opens the task', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const listBranches = vi.spyOn(api, 'listBranches')
    const createTask = vi.spyOn(api, 'createTask')
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    const dialog = within(await openNewTask(user))
    const base = dialog.getByRole('combobox', { name: 'Base branch' })
    await waitFor(() => expect(base).toBeEnabled())
    expect(base).toHaveValue('origin/main')
    expect(dialog.getByRole('option', { name: 'origin/main (default)' })).toBeInTheDocument()
    expect(dialog.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'origin/main (default)',
      'origin/develop',
      'origin/release/2.0',
      'main',
    ])
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'fix login')
    await user.selectOptions(base, 'origin/develop')
    const prompt = dialog.getByRole('textbox', { name: 'Initial prompt (optional)' })
    expect(prompt).toHaveAttribute('maxLength', '10000')
    await user.type(prompt, "Fix it; don't run $(rm -rf ~)")
    expect(dialog.getByText('29 / 10000')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Create' }))

    await screen.findByRole('button', { name: 'Remove task fix login' })
    expect(createTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'fix login', {
      baseRef: 'origin/develop',
      prompt: "Fix it; don't run $(rm -rf ~)",
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(openTarget).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) })),
    )
    expect(await screen.findByLabelText('Git status')).toHaveTextContent('vs origin/develop')
    expect(listBranches).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default base when the branches cannot be listed', async () => {
    const user = userEvent.setup()
    const api = repoApi({ listBranches: async () => Promise.reject(new Error('git fetch failed: no network')) })
    const createTask = vi.spyOn(api, 'createTask')
    render(<App api={api} />)
    const dialog = within(await openNewTask(user))
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Could not list the branches: git fetch failed: no network. The task will start from the default branch.',
    )
    expect(dialog.getByRole('combobox', { name: 'Base branch' })).toBeDisabled()
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'fix{Control>}{Enter}{/Control}')
    await screen.findByRole('button', { name: 'Remove task fix' })
    expect(createTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'fix', {})
  })

  it('keeps the dialog and its fields when creating fails, and Esc cancels', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      createTask: async () => Promise.reject(new Error('Branch "claude/client-x/fix" already exists')),
    })
    render(<App api={api} />)
    const dialog = within(await openNewTask(user))
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'fix')
    await user.type(dialog.getByRole('textbox', { name: 'Initial prompt (optional)' }), 'hello')
    await user.click(dialog.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText(/already exists/)).toBeInTheDocument()
    expect(dialog.getByRole('textbox', { name: 'Initial prompt (optional)' })).toHaveValue('hello')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('App git actions', () => {
  const git = (): ReturnType<typeof within> => within(screen.getByRole('group', { name: 'Git' }))
  const selectedTarget = async (api: MeManagerApi): Promise<Target> => {
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    return { themeId: state.themes[0].id, itemId: repo.id, taskId: repo.kind === 'repo' ? repo.tasks[0].id : '' }
  }

  it('commits all: lists the uncommitted files, needs a message, confirms and refreshes git status', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const listChanges = vi.spyOn(api, 'listChanges')
    const commitAll = vi.spyOn(api, 'commitAll')
    const getGitStatus = vi.spyOn(api, 'getGitStatus')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(git().getByRole('button', { name: 'Commit all…' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Commit all in fix login bug' }))
    expect(dialog.getByText('on claude/client-x/fix-login-bug')).toBeInTheDocument()
    expect(await dialog.findByText('3 files will be committed')).toBeInTheDocument()
    const files = within(dialog.getByRole('list', { name: 'Files to commit' }))
    expect(files.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Unotes.txt',
      'Msrc/app.ts',
      'Dsrc/legacy.ts',
    ])
    const target = await selectedTarget(api)
    expect(listChanges).toHaveBeenCalledWith(target, 'uncommitted')
    const commit = dialog.getByRole('button', { name: 'Commit' })
    expect(commit).toBeDisabled()
    const message = dialog.getByRole('textbox', { name: 'Commit message' })
    expect(message).toHaveFocus()
    expect(message).toHaveAttribute('maxLength', '5000')
    await user.type(message, '  Fix the login redirect  ')
    getGitStatus.mockClear()
    await user.click(commit)
    expect(commitAll).toHaveBeenCalledWith(target, 'Fix the login redirect')
    expect(await screen.findByRole('status')).toHaveTextContent('Committed 3 files')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getGitStatus).toHaveBeenCalled()
  })

  it("shows git's error and keeps the dialog and message when the commit fails", async () => {
    const user = userEvent.setup()
    const identity =
      'git commit failed: Author identity unknown *** Please tell me who you are. fatal: no email was given and auto-detection is disabled'
    const api = repoApi({ commitAll: async () => Promise.reject(new Error(identity)) })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(git().getByRole('button', { name: 'Commit all…' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Commit all in fix login bug' }))
    await dialog.findByText('3 files will be committed')
    await user.type(dialog.getByRole('textbox', { name: 'Commit message' }), 'msg{Control>}{Enter}{/Control}')
    expect(await screen.findByRole('alert')).toHaveTextContent(identity)
    expect(dialog.getByRole('textbox', { name: 'Commit message' })).toHaveValue('msg')
    expect(dialog.getByRole('button', { name: 'Commit' })).toBeEnabled()
  })

  it('says when there is nothing to commit', async () => {
    const user = userEvent.setup()
    const api = repoApi({ listChanges: async () => ({ files: [] }) })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(git().getByRole('button', { name: 'Commit all…' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Commit all in fix login bug' }))
    expect(await dialog.findByText('Nothing to commit')).toBeInTheDocument()
    await user.type(dialog.getByRole('textbox', { name: 'Commit message' }), 'msg')
    expect(dialog.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('pushes the branch, with the Git buttons off meanwhile, and shows a failure', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const api = repoApi()
    const pushTask = vi.fn<MeManagerApi['pushTask']>(async () => {
      await new Promise<void>((r) => (finish = r))
      return { branch: 'claude/client-x/fix-login-bug' }
    })
    api.pushTask = pushTask
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(git().getByRole('button', { name: 'Push branch' }))
    expect(git().getByRole('button', { name: 'Push branch' })).toHaveTextContent('Pushing…')
    for (const b of git().getAllByRole('button')) expect(b).toBeDisabled()
    expect(pushTask).toHaveBeenCalledWith(await selectedTarget(api))
    act(() => finish())
    expect(await screen.findByRole('status')).toHaveTextContent('Pushed claude/client-x/fix-login-bug')
    expect(git().getByRole('button', { name: 'Push branch' })).toBeEnabled()

    api.pushTask = async () => Promise.reject(new Error('git push failed: ! [rejected] x -> x (fetch first)'))
    await user.click(git().getByRole('button', { name: 'Push branch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('git push failed: ! [rejected] x -> x (fetch first)')
  })

  it('opens the pull request in the browser', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const createPullRequest = vi.spyOn(api, 'createPullRequest')
    const openExternal = vi.spyOn(api, 'openExternal')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const pr = git().getByRole('button', { name: 'Open pull request' })
    await waitFor(() => expect(pr).not.toHaveAttribute('aria-disabled'))
    expect(pr).toHaveAttribute('title', expect.stringContaining('gh pr create --fill'))
    await user.click(pr)
    expect(createPullRequest).toHaveBeenCalledWith(await selectedTarget(api))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://github.com/demo/fix-login-bug/pull/1'))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Created a pull request for claude/client-x/fix-login-bug',
    )
    await user.click(pr)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Opened the pull request'))
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('explains how to install gh when it is missing', async () => {
    const user = userEvent.setup()
    const api = repoApi({ getGitTools: async () => ({ gh: false }) })
    const createPullRequest = vi.spyOn(api, 'createPullRequest')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const pr = git().getByRole('button', { name: 'Open pull request' })
    expect(pr).toHaveAttribute('aria-disabled', 'true')
    expect(pr).toHaveAttribute('title', expect.stringContaining('install gh (https://cli.github.com'))
    await user.click(pr)
    expect(await screen.findByRole('alert')).toHaveTextContent('Opening a pull request needs the GitHub CLI')
    expect(createPullRequest).not.toHaveBeenCalled()
  })

  it('runs the git actions from the palette, for tasks only', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const pushTask = vi.spyOn(api, 'pushTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = within(await screen.findByRole('dialog', { name: 'Command palette' }))
    await user.type(palette.getByRole('combobox'), 'git:')
    expect(
      palette
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-label'))
        .sort(),
    ).toEqual(['Git: Commit all…', 'Git: Open pull request', 'Git: Push branch', 'Git: Update from base'])
    await user.type(palette.getByRole('combobox'), ' push')
    await user.keyboard('{Enter}')
    expect(pushTask).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('status')).toHaveTextContent('Pushed claude/client-x/fix-login-bug')

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const again = within(await screen.findByRole('dialog', { name: 'Command palette' }))
    await user.type(again.getByRole('combobox'), 'commit all')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: 'Commit all in fix login bug' })).toBeInTheDocument()
  })

  it('has no Git group for folders', async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi({ pickDirectory: async () => '/home/me/notes' })} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(await screen.findByRole('button', { name: /📁 notes$/ }))
    await screen.findByRole('group', { name: 'Open' })
    expect(screen.queryByRole('group', { name: 'Git' })).not.toBeInTheDocument()
  })
})

describe('App update from base', () => {
  const git = (): ReturnType<typeof within> => within(screen.getByRole('group', { name: 'Git' }))
  const selectedTarget = async (api: MeManagerApi): Promise<Target> => {
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    return { themeId: state.themes[0].id, itemId: repo.id, taskId: repo.kind === 'repo' ? repo.tasks[0].id : '' }
  }

  it('rebases by default, then says when it is up to date, refreshing git status', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const updateFromBase = vi.spyOn(api, 'updateFromBase')
    const getGitStatus = vi.spyOn(api, 'getGitStatus')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const update = git().getByRole('button', { name: 'Update from base' })
    expect(update).toHaveAttribute(
      'title',
      'Fetch, then rebase claude/client-x/fix-login-bug onto origin/main (git rebase)',
    )
    getGitStatus.mockClear()
    await user.click(update)
    expect(updateFromBase).toHaveBeenCalledWith(await selectedTarget(api))
    expect(await screen.findByRole('status')).toHaveTextContent('Rebased onto origin/main (2 new commits)')
    expect(getGitStatus).toHaveBeenCalled()
    await user.click(update)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Already up to date with origin/main'))
  })

  it('merges when Settings say so', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    await api.updateSettings({ updateStrategy: 'merge' })
    render(<App api={api} />)
    await createRepoAndTask(user)
    const update = git().getByRole('button', { name: 'Update from base' })
    await waitFor(() => expect(update).toHaveAttribute('title', expect.stringContaining('git merge --no-edit')))
    await user.click(update)
    expect(await screen.findByRole('status')).toHaveTextContent('Merged origin/main (2 new commits)')
  })

  it('shows why it refused, with the button busy meanwhile', async () => {
    const user = userEvent.setup()
    let fail = (): void => {}
    const api = repoApi({
      updateFromBase: () =>
        new Promise((_, reject) => {
          fail = () => reject(new Error('Commit or stash your changes first: 2 uncommitted files in the task'))
        }),
    })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(git().getByRole('button', { name: 'Update from base' }))
    expect(git().getByRole('button', { name: 'Update from base' })).toHaveTextContent('Updating…')
    expect(git().getByRole('button', { name: 'Update from base' })).toBeDisabled()
    act(() => fail())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Commit or stash your changes first: 2 uncommitted files in the task',
    )
    expect(git().getByRole('button', { name: 'Update from base' })).toBeEnabled()
  })

  it('reports conflicts and asks Claude to resolve them', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const askClaudeToResolve = vi.spyOn(api, 'askClaudeToResolve')
    render(<App api={api} />)
    await createRepoAndTask(user, 'conflict demo')
    await user.click(git().getByRole('button', { name: 'Update from base' }))
    const dialog = within(await screen.findByRole('alertdialog', { name: 'Update stopped on conflicts' }))
    expect(dialog.getByText(/conflicts in 2 files\. It was undone/)).toHaveTextContent(
      'Rebasing claude/client-x/conflict-demo onto origin/main conflicts in 2 files. It was undone (git rebase --abort), so the branch and its files are as they were.',
    )
    expect(
      within(dialog.getByRole('list', { name: 'Conflicting files' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['!src/app.ts', '!src/util/format.ts'])
    const ask = dialog.getByRole('button', { name: 'Ask Claude to resolve' })
    expect(ask).toHaveFocus()
    await user.click(ask)
    expect(askClaudeToResolve).toHaveBeenCalledWith(await selectedTarget(api), 'rebase', [
      'src/app.ts',
      'src/util/format.ts',
    ])
    expect(await screen.findByRole('status')).toHaveTextContent('Asked Claude to resolve the conflicts')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('keeps the conflict dialog when asking Claude fails, and closes with Esc', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      askClaudeToResolve: async () => Promise.reject(new Error('Open the task first: its session is not running')),
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'conflict demo')
    await user.click(git().getByRole('button', { name: 'Update from base' }))
    const dialog = within(await screen.findByRole('alertdialog', { name: 'Update stopped on conflicts' }))
    await user.click(dialog.getByRole('button', { name: 'Ask Claude to resolve' }))
    expect(await screen.findByText('Open the task first: its session is not running')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('updates from the palette', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const updateFromBase = vi.spyOn(api, 'updateFromBase')
    render(<App api={api} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = within(await screen.findByRole('dialog', { name: 'Command palette' }))
    await user.type(palette.getByRole('combobox'), 'update from base')
    expect(palette.getAllByRole('option')[0]).toHaveAttribute('aria-label', 'Git: Update from base')
    await user.keyboard('{Enter}')
    expect(updateFromBase).toHaveBeenCalledTimes(1)
  })
})
