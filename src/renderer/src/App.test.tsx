import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { App, UI_SAVE_MS, ZOOM_SAVE_MS } from './App'
import { createMockApi } from './api/mockApi'
import { budgetStatus } from '../../shared/budget'
import type {
  BudgetAlert,
  BudgetReport,
  MeManagerApi,
  TabInfo,
  Target,
  TaskGitStatus,
  UnsavedWork,
  UsageReport,
  UsageSummary,
} from '../../shared/types'
import { emptyUsageSummary } from '../../shared/usage'
import { fuzzyFilter } from './lib/fuzzy'
import { mockColorScheme } from './test/matchMedia'

vi.mock('./components/TerminalView', () => ({
  TerminalView: ({ fontSize, focusSeq, appearance }: { fontSize: number; focusSeq?: number; appearance: string }) => (
    <div data-testid="terminal" data-font-size={fontSize} data-focus-seq={focusSeq} data-appearance={appearance} />
  ),
}))
// The real matcher, spied on: the palette must not re-run it on App renders that change none of its inputs.
vi.mock('./lib/fuzzy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/fuzzy')>()
  return { ...actual, fuzzyFilter: vi.fn(actual.fuzzyFilter) }
})
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

  it('opens Search in files with Ctrl+Shift+S, focused, without stealing focus when switching tasks', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user, 'task A', 'task B')
    const pressed = fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true })
    expect(pressed).toBe(false) // handled, not sent on to the terminal
    const input = await within(panel()).findByRole('textbox', { name: 'Search in files' })
    expect(within(panel()).getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(input).toHaveFocus())
    await user.type(input, 'formatName{Enter}')
    await user.click(await within(panel()).findByRole('button', { name: /^src\/app\.ts, line 1:/ }))
    expect(within(panel()).getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(document.querySelector('.code-line-mark')).toHaveAttribute('data-line', '1'))

    // Back on the Search tab of another task and back: the query is remembered, focus is not taken.
    await user.click(within(panel()).getByRole('tab', { name: 'Search' }))
    await user.click(taskButton('task A'))
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
    await user.click(taskButton('task B'))
    const again = await within(panel()).findByRole('textbox', { name: 'Search in files' })
    expect(again).toHaveValue('formatName')
    expect(again).not.toHaveFocus()
  })

  it('opens Search in files from the palette', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    await user.type(within(palette).getByRole('combobox'), 'search in files')
    expect(within(palette).getAllByRole('option')[0]).toHaveTextContent('Ctrl+Shift+S')
    await user.keyboard('{Enter}')
    const input = await within(panel()).findByRole('textbox', { name: 'Search in files' })
    await waitFor(() => expect(input).toHaveFocus())
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

describe('App review comments', () => {
  const togglePanel = (user: UserEvent): Promise<void> =>
    user.click(screen.getByRole('button', { name: 'Toggle files panel' }))
  const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Files panel' })
  const codeText = (): string => document.querySelector('.code-body')?.textContent ?? ''
  const tray = (): HTMLElement => screen.getByRole('region', { name: 'Review comments' })
  const main = (): Element => document.querySelector('main')!
  const gutter = (): HTMLElement => within(panel()).getByRole('group', { name: 'Line numbers' })
  /** Clicks line `n`'s number (8px padding, 18px lines; jsdom has no layout). */
  const clickLine = (n: number, shiftKey = false): boolean =>
    fireEvent.click(gutter(), { clientY: 8 + (n - 1) * 18 + 5, shiftKey })
  const targetOf = async (api: MeManagerApi, name: string): Promise<Target> => {
    const state = await api.getState()
    const repo = state.themes[0].items[0]
    const task = repo.kind === 'repo' ? repo.tasks.find((t) => t.name === name) : undefined
    return { themeId: state.themes[0].id, itemId: repo.id, taskId: task?.id ?? '' }
  }
  /** Opens package.json in the panel of the selected task. */
  const openPackageJson = async (user: UserEvent): Promise<void> => {
    await togglePanel(user)
    await user.click(await within(panel()).findByRole('button', { name: 'package.json' }))
    await waitFor(() => expect(codeText()).toContain('demo-project'))
  }
  const addComment = async (user: UserEvent, location: string, note: string): Promise<void> => {
    const dialog = within(await screen.findByRole('dialog', { name: `Comment on ${location}` }))
    await user.type(dialog.getByRole('textbox', { name: 'Comment' }), note)
    await user.click(dialog.getByRole('button', { name: 'Add comment' }))
  }

  it('collects comments on lines, keeps them per task, and pastes them into Claude without Enter', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const sendToClaude = vi.spyOn(api, 'sendToClaude')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    await user.click(taskButton('task A'))
    await openPackageJson(user)
    expect(screen.queryByRole('region', { name: 'Review comments' })).toBeNull()

    clickLine(2)
    clickLine(3, true)
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }))
    expect(main().closest('[inert]')).not.toBeNull() // a modal like the others
    await addComment(user, 'package.json:2-3', 'Pin this version')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(gutter()).toHaveFocus() // given back by the dialog, for the next selection
    expect(within(panel()).queryByRole('button', { name: 'Comment' })).toBeNull() // the selection is done

    // From the keyboard: a line, then C.
    await user.keyboard('{ArrowDown}c')
    const dialog = within(await screen.findByRole('dialog', { name: 'Comment on package.json:1' }))
    await user.type(dialog.getByRole('textbox', { name: 'Comment' }), 'Second{Control>}{Enter}{/Control}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(2)

    // Another task has its own (none); switching back finds them again.
    await user.click(taskButton('task B'))
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()
    await togglePanel(user)
    expect(screen.queryByRole('region', { name: 'Review comments' })).toBeNull()
    await user.click(taskButton('task A'))
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(2)

    const terminal = screen.getByTestId('terminal')
    const focusBefore = terminal.dataset.focusSeq
    await user.click(within(tray()).getByRole('button', { name: 'Send to Claude' }))
    expect(sendToClaude).toHaveBeenCalledWith(
      await targetOf(api, 'task A'),
      'Please address these review comments:\n\npackage.json:2-3\nPin this version\n\npackage.json:1\nSecond',
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Pasted 2 review comments into Claude's prompt: read them and press Enter to send",
    )
    expect(screen.queryByRole('region', { name: 'Review comments' })).toBeNull()
    expect(screen.getByTestId('terminal').dataset.focusSeq).not.toBe(focusBefore) // Claude's tab has focus
  })

  it('keeps the comments when Claude is busy', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      sendToClaude: async () => Promise.reject(new Error("Claude is busy — try again when it's idle")),
    })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await openPackageJson(user)
    clickLine(1)
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }))
    await addComment(user, 'package.json:1', 'Note')
    await user.click(within(tray()).getByRole('button', { name: 'Send to Claude' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Claude is busy — try again when it's idle")
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(1)
    expect(within(tray()).getByRole('button', { name: 'Send to Claude' })).toBeEnabled()
  })

  it('edits, copies and deletes comments', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    render(<App api={api} />)
    await createRepoAndTask(user)
    await openPackageJson(user)
    clickLine(4)
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }))
    await addComment(user, 'package.json:4', 'First draft')

    await user.click(within(tray()).getByRole('button', { name: 'Edit the comment on package.json:4' }))
    const edit = within(screen.getByRole('dialog', { name: 'Edit the comment on package.json:4' }))
    const box = edit.getByRole('textbox', { name: 'Comment' })
    expect(box).toHaveValue('First draft')
    expect(edit.getByRole('button', { name: 'Save' })).toBeDisabled() // unchanged
    await user.clear(box)
    await user.type(box, 'Final')
    await user.click(edit.getByRole('button', { name: 'Save' }))
    expect(within(tray()).getByText('Final')).toBeInTheDocument()
    expect(within(tray()).getByRole('button', { name: 'Edit the comment on package.json:4' })).toHaveFocus()

    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(within(tray()).getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('Please address these review comments:\n\npackage.json:4\nFinal')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied the review comments')
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(1) // copying keeps them

    await user.click(within(tray()).getByRole('button', { name: 'Delete the comment on package.json:4' }))
    expect(screen.queryByRole('region', { name: 'Review comments' })).toBeNull()
  })

  it('cancels a comment with Escape, keeping the selection', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    await openPackageJson(user)
    clickLine(2)
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Review comments' })).toBeNull()
    expect(within(panel()).getByRole('button', { name: 'Comment' })).toBeInTheDocument()
  })

  it("sends a folder's comments to its Claude tab", async () => {
    const user = userEvent.setup()
    const api = createMockApi({ pickDirectory: async () => '/home/me/notes' })
    const sendToClaude = vi.spyOn(api, 'sendToClaude')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(await screen.findByRole('button', { name: /📁 notes$/ }))
    await openPackageJson(user)
    clickLine(1)
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }))
    await addComment(user, 'package.json:1', 'Rename')
    await user.click(within(tray()).getByRole('button', { name: 'Send to Claude' }))
    const state = await api.getState()
    expect(sendToClaude).toHaveBeenCalledWith(
      { themeId: state.themes[0].id, itemId: state.themes[0].items[0].id },
      'Please address these review comments:\n\npackage.json:1\nRename',
    )
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

  it('does not re-run the fuzzy matching when App re-renders for something else', async () => {
    const user = userEvent.setup()
    let ptyExit: (code: number) => void = () => {}
    const api = repoApi({
      // No tabs before the session ends either: the tab actions the palette lists stay the same.
      openTarget: async () => [],
      listTabs: async () => [],
      onPtyExit: (cb) => {
        ptyExit = cb
        return () => {}
      },
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    await openPalette()
    await user.type(search(), 'task')
    await screen.findByRole('option', { name: 'Client X › my-api › task A' })
    const matcher = vi.mocked(fuzzyFilter)
    matcher.mockClear()
    act(() => ptyExit(0)) // App re-renders: the session-ended overlay
    expect(await screen.findByText('Session ended.')).toBeInTheDocument()
    expect(matcher).not.toHaveBeenCalled()
    await user.type(search(), ' B')
    expect(matcher).toHaveBeenCalled() // a new query does match again
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[0]).toHaveAccessibleName(
      'Client X › my-api › task B',
    )
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
  const alt = { ctrlKey: false, altKey: true }
  const twoTabs: TabInfo[] = [
    { index: 0, name: 'claude', active: true },
    { index: 1, name: 'bash', active: false },
  ]

  it('selects the Nth visible task with Alt+1..9, skipping collapsed groups', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B') // task B is selected
    press('1', alt)
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
    press('2', alt)
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()

    openTarget.mockClear()
    press('2', alt) // already selected: nothing to do
    press('3', alt) // there is no third target
    // Ctrl+digits stay with the terminal (Ctrl+3 is ESC, Ctrl+4 SIGQUIT, …): not handled, not prevented
    expect(fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true })).toBe(true)
    expect(openTarget).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /📦 my-api$/ })) // collapse the repo
    press('1', alt)
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
    for (const keys of ['Ctrl+Shift+P', 'Ctrl+Shift+/', 'Ctrl+Shift+E', 'Alt+1…9', 'Ctrl+Shift+T', 'Ctrl+Shift+W'])
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
    press('1', alt, filter)
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

  it('is focused with Ctrl+Shift+F, and Alt+1 counts only the filtered entries', async () => {
    const user = userEvent.setup()
    await setup(user)
    await user.click(taskButton('fix login bug'))
    expect(await screen.findByText('my-api › fix login bug')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(filterBox()).toHaveFocus()
    await user.type(filterBox(), 'tests')
    fireEvent.keyDown(filterBox(), { key: '1', altKey: true }) // ignored while typing in the filter
    expect(screen.getByText('my-api › fix login bug')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '1', altKey: true })
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

describe('App transcripts', () => {
  type WriteText = (text: string) => Promise<void>
  /** Installed after userEvent.setup(), which puts its own clipboard stub on navigator. */
  function mockClipboard(writeText = vi.fn<WriteText>(async () => {})): typeof writeText {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }
  const TWO_TABS: TabInfo[] = [
    { index: 0, name: 'claude', active: false },
    { index: 2, name: 'shell', active: true },
  ]
  const transcript = { text: 'one\ntwo\nthree\n', lines: 3, truncated: false }
  const tabMenu = (name: string): HTMLElement => {
    fireEvent.contextMenu(screen.getByRole('tab', { name }))
    return screen.getByRole('menu', { name: `Tab ${name}` })
  }
  const runFromPalette = async (user: UserEvent, label: string): Promise<void> => {
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    await user.type(await screen.findByRole('combobox'), label)
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(label)
    await user.keyboard('{Enter}')
  }

  it("copies a tab's transcript from its menu and says how many lines", async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    const copyTranscript = vi.fn(async () => transcript)
    render(<App api={repoApi({ copyTranscript, openTarget: async () => TWO_TABS, listTabs: async () => TWO_TABS })} />)
    await createRepoAndTask(user)
    await user.click(within(tabMenu('claude')).getByRole('menuitem', { name: 'Copy transcript' }))
    expect(copyTranscript).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }), 0)
    expect(writeText).toHaveBeenCalledWith('one\ntwo\nthree\n')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied 3 lines')
  })

  it("saves a tab's transcript from its menu and says where", async () => {
    const user = userEvent.setup()
    const saveTranscript = vi.fn(async () => ({ path: '/home/me/Downloads/x-shell.txt', lines: 3, truncated: false }))
    render(<App api={repoApi({ saveTranscript, openTarget: async () => TWO_TABS, listTabs: async () => TWO_TABS })} />)
    await createRepoAndTask(user)
    await user.click(within(tabMenu('shell')).getByRole('menuitem', { name: 'Save transcript…' }))
    expect(saveTranscript).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }), 2)
    expect(await screen.findByRole('status')).toHaveTextContent('Saved to /home/me/Downloads/x-shell.txt')
  })

  it('acts on the current tab from the palette', async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    const copyTranscript = vi.fn(async () => ({ ...transcript, lines: 1 }))
    const saveTranscript = vi.fn(async () => ({ path: '/tmp/t.txt', lines: 1, truncated: false }))
    render(
      <App
        api={repoApi({
          copyTranscript,
          saveTranscript,
          openTarget: async () => TWO_TABS,
          listTabs: async () => TWO_TABS,
        })}
      />,
    )
    await createRepoAndTask(user)
    await runFromPalette(user, 'Copy transcript of current tab')
    expect(copyTranscript).toHaveBeenLastCalledWith(expect.anything(), 2)
    expect(writeText).toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('Copied 1 line')
    await runFromPalette(user, 'Save transcript of current tab')
    expect(saveTranscript).toHaveBeenLastCalledWith(expect.anything(), 2)
    expect(await screen.findByRole('status')).toHaveTextContent('Saved to /tmp/t.txt')
  })

  it('offers no transcript actions without a tab', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi({ openTarget: async () => [], listTabs: async () => [] })} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    await user.type(await screen.findByRole('combobox'), 'transcript')
    expect(screen.queryByRole('option', { name: /transcript/ })).not.toBeInTheDocument()
  })

  it('says when the transcript holds only the most recent part of the scrollback', async () => {
    const user = userEvent.setup()
    mockClipboard()
    const copyTranscript = vi.fn(async () => ({ ...transcript, truncated: true }))
    const saveTranscript = vi.fn(async () => ({ path: '/tmp/t.txt', lines: 3, truncated: true }))
    render(<App api={repoApi({ copyTranscript, saveTranscript })} />)
    await createRepoAndTask(user)
    await user.click(within(tabMenu('claude')).getByRole('menuitem', { name: 'Copy transcript' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Copied 3 lines (the last 20 MB of the scrollback)')
    await user.click(within(tabMenu('claude')).getByRole('menuitem', { name: 'Save transcript…' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Saved to /tmp/t.txt (the last 20 MB of the scrollback)',
    )
  })

  it('shows nothing when the save dialog is cancelled, and errors as error toasts', async () => {
    const user = userEvent.setup()
    mockClipboard(vi.fn<WriteText>(async () => Promise.reject(new Error('denied'))))
    let save: () => Promise<null> = async () => null
    const api = repoApi({ saveTranscript: () => save() })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(within(tabMenu('claude')).getByRole('menuitem', { name: 'Save transcript…' }))
    await act(async () => {})
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    save = async () =>
      Promise.reject(new Error("Error invoking remote method 'api:saveTranscript': Error: That tab is no longer open"))
    await user.click(within(tabMenu('claude')).getByRole('menuitem', { name: 'Save transcript…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^That tab is no longer open/)

    await user.click(within(tabMenu('claude')).getByRole('menuitem', { name: 'Copy transcript' }))
    await waitFor(() =>
      expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('Could not copy the transcript to the clipboard'),
    )
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
      showStatusBar: true,
      taskTemplates: [],
      dailyBudgetUsd: null,
      taskBudgetUsd: null,
      appearance: 'system',
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

describe('App appearance', () => {
  const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Settings' })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.appearance
  })

  it('draws the page and the terminal in the saved appearance, and switches both when it is saved', async () => {
    mockColorScheme(true)
    const user = userEvent.setup()
    const api = repoApi()
    await api.updateSettings({ appearance: 'light' })
    render(<App api={api} />)
    await waitFor(() => expect(document.documentElement.dataset.appearance).toBe('light'))
    await createRepoAndTask(user)
    expect(screen.getByTestId('terminal')).toHaveAttribute('data-appearance', 'light')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(dialog()).getByRole('radio', { name: 'Dark' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(document.documentElement.dataset.appearance).toBe('dark'))
    expect(screen.getByTestId('terminal')).toHaveAttribute('data-appearance', 'dark')
    expect((await api.getSettings()).appearance).toBe('dark')
  })

  it('follows the OS in system mode, before and after the settings arrive', async () => {
    const scheme = mockColorScheme(false)
    render(<App api={repoApi()} />)
    expect(document.documentElement.dataset.appearance).toBe('light')
    act(() => scheme.setDark(true))
    expect(document.documentElement.dataset.appearance).toBe('dark')
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

  describe('budgets', () => {
    /** The id of the task named `name` in the API's state. */
    const taskIdOf = async (api: MeManagerApi, name: string): Promise<string> => {
      const repo = (await api.getState()).themes.flatMap((t) => t.items).find((i) => i.kind === 'repo')
      return (repo?.kind === 'repo' && repo.tasks.find((t) => t.name === name)?.id) || ''
    }
    /** usageApi, with budgets as main reports them: each task's all-time cost and `today` for the day. */
    async function budgetApi(costs: Record<string, number>, today: number): Promise<MeManagerApi> {
      const api: MeManagerApi = usageApi(costs, {
        getBudgets: async () => {
          const s = await api.getSettings()
          const tasks: BudgetReport['tasks'] = {}
          for (const [name, cost] of Object.entries(costs)) {
            const status = budgetStatus(cost, s.taskBudgetUsd)
            const id = await taskIdOf(api, name)
            if (status && id) tasks[id] = status
          }
          return { daily: budgetStatus(today, s.dailyBudgetUsd), tasks }
        },
      })
      await api.updateSettings({ taskBudgetUsd: 5, dailyBudgetUsd: 5 })
      return api
    }

    it('marks the header badge, the status bar and the sidebar row as budgets are reached', async () => {
      const user = userEvent.setup()
      render(<App api={await budgetApi({ 'fix login bug': 6 }, 4.5)} />)
      await createRepoAndTask(user)
      const badge = await screen.findByRole('button', { name: 'Claude usage: $6.00 · 300k tok, over its budget' })
      expect(badge).toHaveClass('budget-over')
      expect(badge).toHaveAccessibleDescription(/\$6\.00 of \$5\.00 task budget \(120%\)/)
      const cost = await screen.findByRole('button', {
        name: "Today's cost $0.60, 90% of the daily budget: show usage",
      })
      expect(cost).toHaveClass('budget-warn')
      expect(cost).toHaveAttribute('title', expect.stringContaining('$4.50 of $5.00 daily budget (90%)'))
      expect(await screen.findByRole('img', { name: 'Over budget: $6.00 of $5.00 task budget' })).toBeInTheDocument()
    })

    it('polls no budgets while none is set', async () => {
      const user = userEvent.setup()
      const api = usageApi({ 'fix login bug': 6 })
      const getBudgets = vi.spyOn(api, 'getBudgets')
      render(<App api={api} />)
      await createRepoAndTask(user)
      await screen.findByRole('button', { name: 'Claude usage: $6.00 · 300k tok' })
      expect(getBudgets).not.toHaveBeenCalled()
      expect(screen.queryByRole('img', { name: /Over budget/ })).not.toBeInTheDocument()
    })

    it("sets and removes a task's own budget from the palette", async () => {
      const user = userEvent.setup()
      const api = usageApi({ 'fix login bug': 3 })
      const setTaskBudget = vi.spyOn(api, 'setTaskBudget')
      render(<App api={api} />)
      await createRepoAndTask(user)
      const palette = async (query: string): Promise<void> => {
        fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
        const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
        await user.type(within(dialog).getByRole('combobox'), query)
        await user.keyboard('{Enter}')
      }
      await palette('set budget')
      const dialog = await screen.findByRole('dialog', { name: 'Budget for fix login bug' })
      await user.type(within(dialog).getByRole('textbox', { name: 'Budget' }), '3.5')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(setTaskBudget).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 3.5)
      expect(await screen.findByText('Set the budget of fix login bug to $3.50')).toBeInTheDocument()
      // 3 of 3.50: the badge warns, from the task's own budget.
      expect(await screen.findByRole('button', { name: /^Claude usage: \$3\.00 .*, 85% of its budget$/ })).toHaveClass(
        'budget-warn',
      )

      await palette('edit budget')
      const again = await screen.findByRole('dialog', { name: 'Budget for fix login bug' })
      await user.clear(within(again).getByRole('textbox', { name: 'Budget' }))
      await user.click(within(again).getByRole('button', { name: 'Remove' }))
      expect(setTaskBudget).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.any(String), null)
      expect(await screen.findByText('Removed the budget of fix login bug')).toBeInTheDocument()
    })

    it('shows a budget alert from main as a toast that opens the usage view', async () => {
      const user = userEvent.setup()
      let alert: ((a: BudgetAlert) => void) | undefined
      render(
        <App
          api={usageApi(
            {},
            {
              onBudgetAlert: (cb) => {
                alert = cb
                return () => (alert = undefined)
              },
            },
          )}
        />,
      )
      await waitFor(() => expect(alert).toBeDefined())
      act(() =>
        alert!({
          title: "Today's budget is used up",
          body: '$10.00 of $10.00 daily budget (all tasks and folders)',
          level: 'over',
        }),
      )
      const toast = await screen.findByText(
        "Today's budget is used up: $10.00 of $10.00 daily budget (all tasks and folders)",
      )
      expect(toast.closest('.toast')).toHaveClass('toast-warning') // ⚠, not the ✓ of a confirmation
      await user.click(within(toast.closest('.toast') as HTMLElement).getByRole('button', { name: 'Usage' }))
      expect(usageDialog()).toBeInTheDocument()
    })

    it('opens the settings from the usage view when no budget is set', async () => {
      const user = userEvent.setup()
      render(<App api={usageApi({})} />)
      await createTheme(user, 'Client X')
      await user.click(screen.getByRole('button', { name: 'Usage' }))
      await user.click(await within(usageDialog()).findByRole('button', { name: 'Set budgets in Settings' }))
      expect(screen.queryByRole('dialog', { name: 'Claude usage' })).not.toBeInTheDocument()
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    })
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

describe('App task templates', () => {
  const REVIEW = { name: 'Review', taskName: 'review-{n}', base: 'origin/develop', prompt: 'Review the diff' }
  const FIX = { name: 'Fix', prompt: 'Fix the bug' }
  const templatesApi = async (extra: Partial<MeManagerApi> = {}): Promise<MeManagerApi> => {
    const api = repoApi(extra)
    await api.updateSettings({ taskTemplates: [REVIEW, FIX] })
    return api
  }
  const newTaskDialog = async (user: UserEvent): Promise<ReturnType<typeof within>> => {
    await user.click(await screen.findByRole('button', { name: 'New task in my-api' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New task in my-api' }))
    await waitFor(() => expect(dialog.getByRole('combobox', { name: 'Base branch' })).toBeEnabled())
    return dialog
  }

  it('creates a task from the template chosen, then starts on it in that repo, and remembers it', async () => {
    const user = userEvent.setup()
    const api = await templatesApi()
    const createTask = vi.spyOn(api, 'createTask')
    const saveUi = vi.spyOn(api, 'saveUiState')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))

    let dialog = await newTaskDialog(user)
    expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveValue('')
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Template' }), 'Review')
    expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('review-1')
    await user.click(dialog.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: 'Remove task review-1' })
    expect(createTask).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'review-1', {
      baseRef: 'origin/develop',
      prompt: 'Review the diff',
    })
    const repoId = createTask.mock.calls[0][1]
    await waitFor(() => expect(saveUi.mock.calls.at(-1)?.[0].lastTemplates).toEqual({ [repoId]: 'Review' }), {
      timeout: 2_000,
    })

    dialog = await newTaskDialog(user)
    expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveValue('Review')
    expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('review-2')
    // Creating without a template forgets it.
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Template' }), '')
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'plain')
    await user.click(dialog.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: 'Remove task plain' })
    dialog = await newTaskDialog(user)
    expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveValue('')
    await waitFor(() => expect(saveUi.mock.calls.at(-1)?.[0]).not.toHaveProperty('lastTemplates'), {
      timeout: 2_000,
    })
  })

  it('starts the New task dialog on the template remembered from an earlier run', async () => {
    const user = userEvent.setup()
    const api = await templatesApi()
    const themeId = (await api.createTheme('Client X')).themes[0].id
    const repoId = (await api.addRepo(themeId, '/home/me/code/my-api')).themes[0].items[0].id
    await api.saveUiState({ version: 1, collapsed: [], panels: {}, lastTemplates: { [repoId]: 'Fix' } })
    render(<App api={api} />)
    const dialog = await newTaskDialog(user)
    expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveValue('Fix')
    expect(dialog.getByRole('textbox', { name: 'Initial prompt (optional)' })).toHaveValue('Fix the bug')
  })

  it("offers each template in the palette for the selected task's repo, opening the dialog filled in", async () => {
    const user = userEvent.setup()
    const api = await templatesApi()
    render(<App api={api} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    const names = within(palette)
      .getAllByRole('option')
      .map((o) => o.getAttribute('aria-label'))
    expect(names).toEqual(expect.arrayContaining(['New task from template: Review', 'New task from template: Fix']))
    await user.type(within(palette).getByRole('combobox'), 'template review')
    await user.keyboard('{Enter}')
    const dialog = within(await screen.findByRole('dialog', { name: 'New task in my-api' }))
    expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveValue('Review')
    expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('review-1')
    expect(dialog.getByRole('textbox', { name: 'Initial prompt (optional)' })).toHaveValue('Review the diff')
    await waitFor(() => expect(dialog.getByRole('combobox', { name: 'Base branch' })).toHaveValue('origin/develop'))
  })

  it('offers no template entries in the palette with nothing selected', async () => {
    render(<App api={await templatesApi()} />)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(palette).queryByRole('option', { name: /New task from template/ })).not.toBeInTheDocument()
  })

  it('saves a template added in Settings, and offers it in the New task dialog', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const updateSettings = vi.spyOn(api, 'updateSettings')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const settings = within(screen.getByRole('region', { name: 'Task templates' }))
    await user.click(settings.getByRole('button', { name: 'Add template' }))
    await user.keyboard('Docs')
    await user.type(settings.getByLabelText('Initial prompt'), 'Update the docs')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskTemplates: [{ name: 'Docs', prompt: 'Update the docs' }] }),
    )
    await screen.findByText('Settings saved')

    const dialog = await newTaskDialog(user)
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Template' }), 'Docs')
    expect(dialog.getByRole('textbox', { name: 'Initial prompt (optional)' })).toHaveValue('Update the docs')
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

describe('App remembers the UI across restarts', () => {
  /** A demo API with a theme, a repo and two tasks, as if left by an earlier run. */
  async function seeded(extra: Partial<MeManagerApi> = {}): Promise<{
    api: MeManagerApi
    themeId: string
    repoId: string
    taskA: Target
    taskB: Target
  }> {
    const api = repoApi(extra)
    const themeId = (await api.createTheme('Client X')).themes[0].id
    const repoId = (await api.addRepo(themeId, '/home/me/code/my-api')).themes[0].items[0].id
    await api.createTask(themeId, repoId, 'task A')
    const state = await api.createTask(themeId, repoId, 'task B')
    const repo = state.themes[0].items[0]
    const [a, b] = repo.kind === 'repo' ? repo.tasks : []
    return {
      api,
      themeId,
      repoId,
      taskA: { themeId, itemId: repoId, taskId: a.id },
      taskB: { themeId, itemId: repoId, taskId: b.id },
    }
  }

  it('restores the selection, its panel, the panel width and the sidebar filter, and opens the target', async () => {
    const { api, taskA } = await seeded()
    await api.saveUiState({
      version: 1,
      selected: taskA,
      collapsed: [],
      panels: { [taskA.taskId as string]: { open: true, tab: 'files', selected: 'README.md' } },
      panelWidth: 0.5,
      sidebarFilter: 'task',
    })
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
    expect(openTarget).toHaveBeenCalledWith(taskA)
    const panel = await screen.findByRole('complementary', { name: 'Files panel' })
    expect(panel.style.getPropertyValue('--panel-width')).toBe('50.00%')
    expect(await within(panel).findByRole('button', { name: 'README.md' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('textbox', { name: 'Filter sidebar' })).toHaveValue('task')
  })

  it('restores collapsed groups', async () => {
    const { api, repoId } = await seeded()
    await api.saveUiState({ version: 1, collapsed: [repoId], panels: {} })
    render(<App api={api} />)
    expect(await screen.findByRole('button', { name: /📦 my-api$/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(\S )?task A$/ })).not.toBeInTheDocument())
  })

  it('ignores a saved selection that no longer exists, without an error', async () => {
    const { api, themeId, repoId, taskA } = await seeded()
    await api.saveUiState({ version: 1, selected: taskA, collapsed: [], panels: {} })
    await api.removeTask(themeId, repoId, taskA.taskId as string, true)
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    expect(await screen.findByText('Select a task or folder, or create one from the sidebar.')).toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(openTarget).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("doesn't open a saved selection whose folder is missing, or that fails to open, and shows no error", async () => {
    const { api, taskA } = await seeded()
    await api.saveUiState({ version: 1, selected: taskA, collapsed: [], panels: {} })
    api.getStatus = async () => ({ running: [], missing: [taskA.taskId as string], activity: {} })
    const openTarget = vi.spyOn(api, 'openTarget')
    const { unmount } = render(<App api={api} />)
    await screen.findByText('Select a task or folder, or create one from the sidebar.')
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(openTarget).not.toHaveBeenCalled()
    unmount() // which saves the UI as it is now: nothing selected

    await api.saveUiState({ version: 1, selected: taskA, collapsed: [], panels: {} })
    api.getStatus = async () => ({ running: [], missing: [], activity: {} })
    openTarget.mockRejectedValue(new Error('tmux exploded'))
    render(<App api={api} />)
    await waitFor(() => expect(openTarget).toHaveBeenCalledWith(taskA))
    expect(await screen.findByText('Select a task or folder, or create one from the sidebar.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('saves the UI debounced, and at once before the window unloads', async () => {
    const user = userEvent.setup()
    const { api, taskB } = await seeded()
    const save = vi.spyOn(api, 'saveUiState')
    render(<App api={api} />)
    await waitFor(() => taskButton('task B'))
    await user.click(taskButton('task B'))
    await screen.findByText('my-api › task B')
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2_000 })
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ selected: taskB, collapsed: [] })

    save.mockClear()
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
    expect(save).not.toHaveBeenCalled() // waits for UI_SAVE_MS
    window.dispatchEvent(new Event('beforeunload'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].panels).toEqual({ [taskB.taskId as string]: { open: true, tab: 'files' } })
    await act(() => new Promise((r) => setTimeout(r, UI_SAVE_MS + 100)))
    expect(save).toHaveBeenCalledTimes(1) // the pending save went out with the flush
  })

  it('never saves before the saved UI state was read, so it cannot be overwritten', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const { api } = await seeded()
    const real = api.getUiState
    api.getUiState = async () => {
      await gate
      return real()
    }
    const save = vi.spyOn(api, 'saveUiState')
    render(<App api={api} />)
    await waitFor(() => taskButton('task B'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter sidebar' }), { target: { value: 'b' } })
    await act(() => new Promise((r) => setTimeout(r, UI_SAVE_MS + 100)))
    window.dispatchEvent(new Event('beforeunload'))
    expect(save).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2_000 })
  })
})

describe('App removing themes, repos and folders', () => {
  /** A theme "Client X" with the repo my-api and the folder notes (in that order); `paths` picks them. */
  async function setupTheme(user: UserEvent, extra: Partial<MeManagerApi> = {}): Promise<MeManagerApi> {
    const paths = ['/home/me/code/my-api', '/home/me/docs/notes']
    const api = createMockApi({ pickDirectory: async () => paths.shift() ?? null, ...extra })
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await screen.findByRole('button', { name: 'Remove notes' })
    return api
  }
  const itemNames = async (api: MeManagerApi): Promise<string[]> =>
    (await api.getState()).themes.flatMap((t) => t.items.map((i) => `${t.name}/${i.name}`))

  it('asks before removing a repo, saying the files stay; Cancel and Esc keep it', async () => {
    const user = userEvent.setup()
    const api = await setupTheme(user)
    const removeItem = vi.spyOn(api, 'removeItem')
    await user.click(screen.getByRole('button', { name: 'Remove my-api' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove repository my-api' })
    expect(dialog).toHaveTextContent('Remove repository “my-api”?')
    expect(dialog).toHaveTextContent('The repository is removed from Client X.')
    expect(dialog).toHaveTextContent('/home/me/code/my-api')
    expect(dialog).toHaveTextContent('Your files on disk are not touched.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove my-api' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(removeItem).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Remove my-api' })).toBeInTheDocument()
  })

  it('removes a repo once confirmed, and Undo puts it back as it was, in its place', async () => {
    const user = userEvent.setup()
    const api = await setupTheme(user)
    const before = (await api.getState()).themes[0].items
    const restoreItem = vi.spyOn(api, 'restoreItem')
    await user.click(screen.getByRole('button', { name: 'Remove my-api' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove my-api' })).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(await itemNames(api)).toEqual(['Client X/notes'])
    const toast = screen.getByRole('status')
    expect(toast).toHaveTextContent('Removed repository “my-api”')

    await user.click(within(toast).getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: 'Remove my-api' })).toBeInTheDocument()
    expect(restoreItem).toHaveBeenCalledWith(expect.any(String), before[0], 0)
    expect((await api.getState()).themes[0].items).toEqual(before)
    expect(screen.getByRole('status')).toHaveTextContent('Restored repository “my-api”')
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('removes a folder, closing its selection, and Undo brings it back', async () => {
    const user = userEvent.setup()
    const api = await setupTheme(user)
    await user.click(screen.getByRole('button', { name: /📁 notes$/ }))
    expect(await screen.findByTestId('terminal')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove notes' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove folder notes' })
    expect(dialog).toHaveTextContent('The folder is removed from Client X, and its terminal session is closed.')
    expect(dialog).toHaveTextContent('Your files on disk are not touched.')
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByTestId('terminal')).not.toBeInTheDocument())
    expect(await itemNames(api)).toEqual(['Client X/my-api'])
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: 'Remove notes' })).toBeInTheDocument()
    expect(await itemNames(api)).toEqual(['Client X/my-api', 'Client X/notes'])
  })

  it('removes a theme with its items once confirmed, and Undo restores all of it', async () => {
    const user = userEvent.setup()
    const api = await setupTheme(user)
    await user.click(screen.getByRole('button', { name: 'New theme' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Personal')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: 'Remove theme Personal' })
    const before = await api.getState()

    await user.click(screen.getByRole('button', { name: 'Remove theme Client X' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove theme Client X' })
    expect(dialog).toHaveTextContent('The theme is removed from me-manager, with its 1 repository and 1 folder.')
    expect(dialog).toHaveTextContent('Your files on disk are not touched.')
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove theme Client X' })).not.toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Removed theme “Client X”')

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: 'Remove theme Client X' })).toBeInTheDocument()
    expect(await api.getState()).toEqual(before)
    expect(screen.getByRole('button', { name: 'Remove my-api' })).toBeInTheDocument()
  })

  it('refuses at once, without a dialog, while a repo or theme has tasks', async () => {
    const user = userEvent.setup()
    const api = await setupTheme(user)
    const removeItem = vi.spyOn(api, 'removeItem')
    await createTask(user, 'fix')
    await user.click(screen.getByRole('button', { name: 'Remove my-api' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Remove the tasks in "my-api" first')
    await user.click(screen.getByRole('button', { name: 'Remove theme Client X' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('Remove the tasks in "Client X" first')
    expect(removeItem).not.toHaveBeenCalled()
  })

  it('puts removals back in their places whatever order they are undone in', async () => {
    const user = userEvent.setup()
    const paths = ['/home/me/code/my-api', '/home/me/docs/notes', '/home/me/docs/specs']
    const api = createMockApi({ pickDirectory: async () => paths.shift() ?? null })
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await screen.findByRole('button', { name: 'Remove specs' })
    const names = ['Client X/my-api', 'Client X/notes', 'Client X/specs']
    expect(await itemNames(api)).toEqual(names)
    const undo = (message: string): HTMLElement =>
      within(screen.getAllByRole('status').find((t) => t.textContent?.includes(message))!).getByRole('button', {
        name: 'Undo',
      })

    // [A, B, C]: remove A, then B; undo A, then B.
    await user.click(screen.getByRole('button', { name: 'Remove my-api' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove my-api' })).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Remove notes' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes' })).not.toBeInTheDocument())
    expect(await itemNames(api)).toEqual(['Client X/specs'])
    await user.click(undo('Removed repository “my-api”'))
    await screen.findByRole('button', { name: 'Remove my-api' })
    await user.click(undo('Removed folder “notes”'))
    await screen.findByRole('button', { name: 'Remove notes' })
    expect(await itemNames(api)).toEqual(names)

    // The same with themes: [Client X, Personal, Work], remove Client X then Personal, undo oldest first.
    for (const name of ['Personal', 'Work']) {
      await user.click(screen.getByRole('button', { name: 'New theme' }))
      await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
      await user.click(screen.getByRole('button', { name: 'Create' }))
      await screen.findByRole('button', { name: `Remove theme ${name}` })
    }
    const themeNames = async (): Promise<string[]> => (await api.getState()).themes.map((t) => t.name)
    for (const name of ['Client X', 'Personal']) {
      await user.click(screen.getByRole('button', { name: `Remove theme ${name}` }))
      await user.click(screen.getByRole('button', { name: 'Remove' }))
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: `Remove theme ${name}` })).not.toBeInTheDocument(),
      )
    }
    await user.click(undo('Removed theme “Client X”'))
    await screen.findByRole('button', { name: 'Remove theme Client X' })
    await user.click(undo('Removed theme “Personal”'))
    await screen.findByRole('button', { name: 'Remove theme Personal' })
    expect(await themeNames()).toEqual(['Client X', 'Personal', 'Work'])
  })

  it('shows why an undo failed', async () => {
    const user = userEvent.setup()
    await setupTheme(user, {
      restoreItem: async () => {
        throw new Error('/home/me/code/my-api is already in this theme')
      },
    })
    await user.click(screen.getByRole('button', { name: 'Remove my-api' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('/home/me/code/my-api is already in this theme')
  })
})

describe('App clone repository', () => {
  async function setupClone(extra: Partial<MeManagerApi> = {}): Promise<{ user: UserEvent; api: MeManagerApi }> {
    const user = userEvent.setup()
    const api = createMockApi({ pickDirectory: async () => '/home/me/src', ...extra })
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    return { user, api }
  }
  const cloneDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Clone repository into Client X' })
  const field = (name: string): HTMLElement => within(cloneDialog()).getByLabelText(name)

  it('clones from the theme row into the chosen folder, names it after the URL, and remembers the folder', async () => {
    const { user, api } = await setupClone()
    const cloneRepo = vi.spyOn(api, 'cloneRepo')
    await user.click(screen.getByRole('button', { name: 'Clone repository into Client X' }))
    expect(field('Repository URL')).toHaveFocus()
    expect(field('Clone into')).toHaveValue('')
    expect(within(cloneDialog()).getByRole('button', { name: 'Clone' })).toBeDisabled()

    await user.type(field('Repository URL'), 'git@github.com:acme/my-api.git')
    expect(field('Folder name')).toHaveValue('my-api')
    await user.click(within(cloneDialog()).getByRole('button', { name: 'Choose…' }))
    expect(field('Clone into')).toHaveValue('/home/me/src')
    expect(cloneDialog()).toHaveTextContent('Clones to /home/me/src/my-api, which must not exist yet.')
    await user.click(within(cloneDialog()).getByRole('button', { name: 'Clone' }))

    expect(cloneRepo).toHaveBeenCalledWith(
      expect.any(String),
      'git@github.com:acme/my-api.git',
      '/home/me/src',
      'my-api',
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'New task in my-api' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Cloned my-api into Client X')

    // The next clone starts in the same folder.
    await user.click(screen.getByRole('button', { name: 'Clone repository into Client X' }))
    expect(field('Clone into')).toHaveValue('/home/me/src')
  })

  it('starts in the last clone folder from Settings and keeps an edited name', async () => {
    const api = createMockApi()
    await api.updateSettings({ cloneDirectory: '/srv/code' })
    const cloneRepo = vi.spyOn(api, 'cloneRepo')
    const user = userEvent.setup()
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Clone repository into Client X' }))
    await waitFor(() => expect(field('Clone into')).toHaveValue('/srv/code'))
    await user.type(field('Repository URL'), 'https://github.com/acme/api')
    await user.clear(field('Folder name'))
    await user.type(field('Folder name'), 'acme-api')
    await user.type(field('Repository URL'), '.git')
    expect(field('Folder name')).toHaveValue('acme-api')
    await user.keyboard('{Enter}')
    expect(cloneRepo).toHaveBeenCalledWith(
      expect.any(String),
      'https://github.com/acme/api.git',
      '/srv/code',
      'acme-api',
    )
  })

  it('explains a URL or name it refuses, with Clone off', async () => {
    const { user, api } = await setupClone()
    const cloneRepo = vi.spyOn(api, 'cloneRepo')
    await user.click(screen.getByRole('button', { name: 'Clone repository into Client X' }))
    await user.click(within(cloneDialog()).getByRole('button', { name: 'Choose…' }))
    await user.type(field('Repository URL'), '-u touch /tmp/pwned')
    await user.tab()
    expect(within(cloneDialog()).getByRole('alert')).toHaveTextContent('A URL can’t start with “-”')
    expect(field('Repository URL')).toHaveAttribute('aria-invalid', 'true')
    expect(within(cloneDialog()).getByRole('button', { name: 'Clone' })).toBeDisabled()

    await user.clear(field('Repository URL'))
    await user.type(field('Repository URL'), 'ext::sh')
    expect(within(cloneDialog()).getByRole('alert')).toHaveTextContent('ext:: and fd::')

    await user.clear(field('Repository URL'))
    await user.type(field('Repository URL'), 'https://github.com/a/b')
    expect(within(cloneDialog()).queryByRole('alert')).not.toBeInTheDocument()
    await user.clear(field('Folder name'))
    await user.type(field('Folder name'), '..')
    expect(within(cloneDialog()).getByRole('alert')).toHaveTextContent('Choose another folder name')
    expect(within(cloneDialog()).getByRole('button', { name: 'Clone' })).toBeDisabled()
    expect(cloneRepo).not.toHaveBeenCalled()
  })

  it('shows "Cloning…" while it runs, then git\'s error, staying open; Esc closes it after', async () => {
    const gate = deferred()
    const { user } = await setupClone({
      cloneRepo: async () => {
        await gate.promise
        throw new Error(
          "Error invoking remote method 'api:cloneRepo': Error: git clone failed: fatal: repository not found",
        )
      },
    })
    await user.click(screen.getByRole('button', { name: 'Clone repository into Client X' }))
    await user.type(field('Repository URL'), 'https://github.com/acme/private')
    await user.click(within(cloneDialog()).getByRole('button', { name: 'Choose…' }))
    await user.click(within(cloneDialog()).getByRole('button', { name: 'Clone' }))
    expect(within(cloneDialog()).getByRole('status')).toHaveTextContent('Cloning…')
    expect(within(cloneDialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(field('Repository URL')).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(cloneDialog()).toBeInTheDocument() // can't be closed while cloning

    gate.resolve()
    expect(await within(cloneDialog()).findByRole('alert')).toHaveTextContent(
      'git clone failed: fatal: repository not found',
    )
    expect(field('Repository URL')).toHaveValue('https://github.com/acme/private')
    expect(within(cloneDialog()).getByRole('button', { name: 'Clone' })).toBeEnabled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('App status bar', () => {
  const statusBar = (): HTMLElement => screen.getByRole('group', { name: 'Status bar' })
  const openPalette = async (): Promise<HTMLElement> => {
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    return screen.findByRole('dialog', { name: 'Command palette' })
  }

  it("shows the selected task's git standing, Claude state, tabs and today's cost from the mock data", async () => {
    const user = userEvent.setup()
    const api = repoApi({
      getStatus: async () => {
        const task = (await api.getState()).themes[0]?.items.flatMap((i) => (i.kind === 'repo' ? i.tasks : []))[0]
        return { running: task ? [task.id] : [], missing: [], activity: task ? { [task.id]: 'waiting' } : {} }
      },
    })
    render(<App api={api} />)
    await createRepoAndTask(user)
    const bar = within(statusBar())
    expect(bar.getByRole('button', { name: 'Branch claude/client-x/fix-login-bug: copy' })).toBeInTheDocument()
    // demoGitStatus('fix login bug'): its numbers, as the header shows them too.
    expect(await bar.findByText('Work on fix login bug')).toBeInTheDocument()
    expect(bar.getByRole('button', { name: /uncommitted files?: show changes$/ })).toBeInTheDocument()
    expect(await bar.findByText('Claude waiting')).toBeInTheDocument()
    expect(bar.getByText('1 tab')).toBeInTheDocument()
    expect(await bar.findByRole('button', { name: /^Today's cost \$\d+\.\d\d: show usage$/ })).toBeInTheDocument()
    expect(bar.getByText('⚠ skip-perms')).toBeInTheDocument() // on by default
  })

  it("doesn't claim permissions are skipped when the claude arguments choose a permission mode", async () => {
    const user = userEvent.setup()
    const api = repoApi()
    await api.updateSettings({ claudeArgs: ['--permission-mode', 'plan'], skipPermissions: true })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await screen.findByRole('group', { name: 'Status bar' })
    expect(screen.getByText('Remote')).toBeInTheDocument() // the other flag still shows
    expect(screen.queryByText('⚠ permissions skipped')).not.toBeInTheDocument()
    expect(screen.queryByText('⚠ skip-perms')).not.toBeInTheDocument()
  })

  it('copies the branch, opens the Changes tab and the usage view from its segments', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await user.click(within(statusBar()).getByRole('button', { name: /^Branch / }))
    expect(writeText).toHaveBeenLastCalledWith('claude/client-x/fix-login-bug')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied branch name')

    await user.click(await within(statusBar()).findByRole('button', { name: /show changes$/ }))
    const panel = await screen.findByRole('complementary', { name: 'Files panel' })
    expect(await within(panel).findByRole('tab', { name: /^Changes/ })).toHaveAttribute('aria-selected', 'true')

    await user.click(await within(statusBar()).findByRole('button', { name: /^Today's cost/ }))
    expect(screen.getByRole('dialog', { name: 'Claude usage' })).toBeInTheDocument()
  })

  it("shows a folder's path and session state only", async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi({ pickDirectory: async () => '/home/me/notes' })} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add folder to Client X' }))
    await user.click(await screen.findByRole('button', { name: /📁 notes$/ }))
    const bar = within(statusBar())
    expect(bar.getByText('/home/me/notes')).toBeInTheDocument()
    expect(bar.getByText('No session')).toBeInTheDocument()
    expect(bar.queryAllByRole('button')).toHaveLength(0)
  })

  it('hides with the palette action and the setting, and remembers it', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const updateSettings = vi.spyOn(api, 'updateSettings')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(statusBar()).toBeInTheDocument()

    await user.type(within(await openPalette()).getByRole('combobox'), 'toggle status bar')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('group', { name: 'Status bar' })).not.toBeInTheDocument()
    expect(updateSettings).toHaveBeenLastCalledWith({ showStatusBar: false })
    expect((await api.getSettings()).showStatusBar).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const checkbox = within(dialog).getByRole('checkbox', { name: 'Status bar' })
    expect(checkbox).not.toBeChecked()
    await user.click(checkbox)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('group', { name: 'Status bar' })).toBeInTheDocument()
  })

  it('puts the bar back when saving the toggle fails', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi({ updateSettings: async () => Promise.reject(new Error('disk full')) })} />)
    await createRepoAndTask(user)
    await user.type(within(await openPalette()).getByRole('combobox'), 'toggle status bar')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(statusBar()).toBeInTheDocument()
  })
})

describe('App theme colours and icons', () => {
  const customizeDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Customize theme' })

  it('customizes a theme from its row: colour swatch, emoji grid, free-text emoji', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const customize = vi.spyOn(api, 'customizeTheme')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Customize theme Client X' }))
    const dialog = within(customizeDialog())
    expect(dialog.getByRole('radio', { name: 'No colour' })).toBeChecked()
    expect(dialog.getAllByRole('radio')).toHaveLength(9)
    expect(within(dialog.getByRole('group', { name: 'Common emoji' })).getAllByRole('button')).toHaveLength(24)

    await user.click(dialog.getByRole('radio', { name: 'Teal' }))
    await user.click(dialog.getByRole('button', { name: 'Icon 🧪' }))
    expect(dialog.getByRole('textbox', { name: 'Emoji' })).toHaveValue('🧪')
    expect(dialog.getByRole('button', { name: 'Icon 🧪' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    expect(customize).toHaveBeenLastCalledWith(expect.any(String), { color: 'teal', icon: '🧪' })
    expect(screen.queryByRole('dialog', { name: 'Customize theme' })).not.toBeInTheDocument()
    const label = screen.getByRole('button', { name: '▼ Client X' })
    expect(label).toHaveTextContent('🧪')
    expect(label.closest('.theme-row')).toHaveClass('has-color')

    // Reopened, it shows what was saved; a typed emoji replaces the icon, and text is refused before saving.
    await user.click(screen.getByRole('button', { name: 'Customize theme Client X' }))
    const again = within(customizeDialog())
    expect(again.getByRole('radio', { name: 'Teal' })).toBeChecked()
    const field = again.getByRole('textbox', { name: 'Emoji' })
    await user.clear(field)
    await user.type(field, 'hi')
    expect(again.getByText('Use a single emoji')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(again.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.clear(field)
    await user.type(field, '🦄')
    await user.click(again.getByRole('radio', { name: 'No colour' }))
    await user.click(again.getByRole('button', { name: 'Save' }))
    expect(customize).toHaveBeenLastCalledWith(expect.any(String), { icon: '🦄' })
    expect(screen.getByRole('button', { name: '▼ Client X' }).closest('.theme-row')).not.toHaveClass('has-color')
  })

  it('opens from the palette for the selected task, and lists tasks with their theme icon', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    render(<App api={api} />)
    await createRepoAndTask(user)
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    await user.type(await screen.findByRole('combobox'), 'customize theme')
    await user.keyboard('{Enter}')
    const dialog = within(customizeDialog())
    expect(dialog.getByRole('heading')).toHaveTextContent('Customize theme Client X')
    await user.click(dialog.getByRole('button', { name: 'Icon 🚀' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Customize theme' })).not.toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const option = within(await screen.findByRole('dialog', { name: 'Command palette' })).getByRole('option', {
      name: 'Client X › my-api › fix login bug',
    })
    expect(option.querySelector('.palette-icon')).toHaveTextContent('🚀')
  })

  it('cancels with Esc without saving', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const customize = vi.spyOn(api, 'customizeTheme')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Customize theme Client X' }))
    await user.click(within(customizeDialog()).getByRole('radio', { name: 'Red' }))
    fireEvent.keyDown(customizeDialog(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Customize theme' })).not.toBeInTheDocument()
    expect(customize).not.toHaveBeenCalled()
  })
})

describe('App welcome and home screens', () => {
  const welcome = (): HTMLElement => screen.getByRole('region', { name: 'Welcome to me-manager' })
  const home = (): HTMLElement => screen.getByRole('region', { name: 'Home' })

  it('welcomes a first run with an explanation and creates a theme from it', async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi()} />)
    const w = within(await screen.findByRole('region', { name: 'Welcome to me-manager' }))
    expect(
      w.getByText(/Each one is its own git worktree and branch, with its own\s+Claude session/),
    ).toBeInTheDocument()
    await user.click(w.getByRole('button', { name: /^Create a theme/ }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Client X')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('button', { name: 'Remove theme Client X' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Welcome to me-manager' })).not.toBeInTheDocument()
    expect(home()).toHaveTextContent('Select a task or folder, or create one from the sidebar.')
  })

  it('adds a repository from the welcome screen, asking for a theme first', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const addRepo = vi.spyOn(api, 'addRepo')
    render(<App api={api} />)
    await user.click(
      within(await screen.findByRole('region', { name: /^Welcome/ })).getByRole('button', {
        name: /^Add a repository/,
      }),
    )
    const dialog = screen.getByRole('dialog', { name: 'New theme' })
    expect(dialog).toHaveTextContent('Repositories go into a theme')
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Work')
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }))
    const themeId = (await api.getState()).themes[0].id
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith(themeId, '/home/me/code/my-api'))
    expect(await screen.findByRole('button', { name: /📦 my-api$/ })).toBeInTheDocument()
  })

  it('clones into the only theme, or asks which theme when there are several', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    await api.createTheme('Work')
    render(<App api={api} />)
    await user.click(
      within(await screen.findByRole('region', { name: 'Home' })).getByRole('button', { name: /^Clone a repository/ }),
    )
    expect(screen.getByRole('dialog', { name: 'Clone repository into Work' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'New theme' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Side')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: 'Remove theme Side' })
    await user.click(within(home()).getByRole('button', { name: /^Clone a repository/ }))
    const choose = screen.getByRole('dialog', { name: 'Clone a repository' })
    await user.click(within(choose).getByRole('button', { name: 'Side' }))
    expect(screen.getByRole('dialog', { name: 'Clone repository into Side' })).toBeInTheDocument()
  })

  it('asks which theme a repository goes into, and Cancel adds nothing', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    await api.createTheme('Work')
    await api.createTheme('Side')
    const addRepo = vi.spyOn(api, 'addRepo')
    render(<App api={api} />)
    await user.click(
      within(await screen.findByRole('region', { name: 'Home' })).getByRole('button', { name: /^Add a repository/ }),
    )
    await user.click(
      within(screen.getByRole('dialog', { name: 'Add a repository' })).getByRole('button', { name: 'Cancel' }),
    )
    expect(addRepo).not.toHaveBeenCalled()
    await user.click(within(home()).getByRole('button', { name: /^Add a repository/ }))
    await user.click(
      within(screen.getByRole('dialog', { name: 'Add a repository' })).getByRole('button', { name: 'Side' }),
    )
    const sideId = (await api.getState()).themes[1].id
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith(sideId, '/home/me/code/my-api'))
  })

  it('opens the keyboard shortcuts from the welcome screen', async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi()} />)
    await screen.findByRole('region', { name: /^Welcome/ })
    await user.click(within(welcome()).getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('lists the 5 newest tasks when nothing is selected, and opens one', async () => {
    const api = repoApi()
    let s = await api.createTheme('Work')
    s = await api.addRepo(s.themes[0].id, '/home/me/code/my-api')
    const themeId = s.themes[0].id
    const repoId = s.themes[0].items[0].id
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) s = await api.createTask(themeId, repoId, name)
    // Created in that order, a minute apart.
    const repo = s.themes[0].items[0]
    if (repo.kind === 'repo')
      repo.tasks.forEach((t, i) => (t.createdAt = new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString()))
    api.getState = async () => s
    const openTarget = vi.spyOn(api, 'openTarget')
    const user = userEvent.setup()
    render(<App api={api} />)
    const list = within(await screen.findByRole('region', { name: 'Home' })).getByRole('list')
    const buttons = within(list).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open six (Work › my-api)',
      'Open five (Work › my-api)',
      'Open four (Work › my-api)',
      'Open three (Work › my-api)',
      'Open two (Work › my-api)',
    ])
    await user.click(buttons[2])
    const four = repo.kind === 'repo' ? repo.tasks.find((t) => t.name === 'four') : undefined
    expect(openTarget).toHaveBeenCalledWith({ themeId, itemId: repoId, taskId: four?.id })
    expect(await screen.findByText('my-api › four')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Home' })).not.toBeInTheDocument()
  })

  it('shows a tip that rotates, and opens the palette from the quick actions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = createMockApi()
      await api.createTheme('Work')
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<App api={api} />)
      const tip = (): string => within(home()).getByText(/^Press |opens|searches|filters|shows|lists/).textContent ?? ''
      await screen.findByRole('region', { name: 'Home' })
      expect(tip()).toBe('Press Ctrl+Shift+P to jump to any task, folder, file or action.')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000)
      })
      expect(tip()).toContain('Ctrl+Shift+E')
      await user.click(within(home()).getByRole('button', { name: 'Next tip' }))
      expect(tip()).toContain('Ctrl+Shift+S')
      await user.click(within(home()).getByRole('button', { name: /^Command palette/ }))
      expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows neither screen before the state has loaded', async () => {
    let resolve: (s: Awaited<ReturnType<MeManagerApi['getState']>>) => void = () => {}
    const api = createMockApi({ getState: () => new Promise((r) => (resolve = r)) })
    render(<App api={api} />)
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(screen.queryByRole('region', { name: /^Welcome/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Home' })).not.toBeInTheDocument()
    await act(async () => resolve({ version: 1, themes: [] }))
    expect(await screen.findByRole('region', { name: /^Welcome/ })).toBeInTheDocument()
  })
})

describe('App modal focus', () => {
  const sidebar = (): Element => document.querySelector('.sidebar')!
  const main = (): Element => document.querySelector('main')!
  const statusBar = (): HTMLElement => screen.getByRole('group', { name: 'Status bar' })
  const expectInert = (inert: boolean): void => {
    for (const el of [sidebar(), main(), statusBar()]) {
      if (inert) expect(el.closest('[inert]'), el.className).not.toBeNull()
      else expect(el.closest('[inert]'), el.className).toBeNull()
    }
  }

  it('makes the sidebar, the main area and the status bar inert while any dialog or overlay is open', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user)
    await screen.findByRole('group', { name: 'Status bar' })
    expectInert(false)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expectInert(true)
    await user.keyboard('{Escape}')
    expectInert(false)

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true }) // palette
    expectInert(true)
    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true }) // help replaces it
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expectInert(true)
    fireEvent.keyDown(window, { key: 'U', ctrlKey: true, shiftKey: true }) // usage
    expectInert(true)
    fireEvent.keyDown(window, { key: 'U', ctrlKey: true, shiftKey: true })
    expectInert(false)

    await user.click(screen.getByRole('button', { name: 'New task in my-api' }))
    expectInert(true)
    await user.keyboard('{Escape}')
    expectInert(false)

    await user.click(screen.getByRole('button', { name: 'Customize theme Client X' }))
    expectInert(true)
    await user.keyboard('{Escape}')
    expectInert(false)
  })
})

describe('App background actions and the dialog shown by then', () => {
  /** An api whose createTask waits for `gate`. */
  function slowApi(gate: Deferred): MeManagerApi {
    const api = repoApi()
    const createTask = api.createTask
    api.createTask = async (...args) => {
      await gate.promise
      return createTask(...args)
    }
    return api
  }

  const startTask = async (user: UserEvent, name: string): Promise<void> => {
    await user.click(await screen.findByRole('button', { name: 'New task in my-api' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
    await user.click(screen.getByRole('button', { name: 'Create' }))
  }

  it('keeps Settings, opened while a task was being created, and does not jump to the new task', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const api = slowApi(gate)
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
    await startTask(user, 'slow task')
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()

    gate.resolve()
    expect(await screen.findByRole('button', { name: 'Remove task slow task' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    expect(openTarget).not.toHaveBeenCalled()
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument()
  })

  it('still opens the new task when the dialog was only dismissed meanwhile', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const api = slowApi(gate)
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createTheme(user, 'Client X')
    await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
    await startTask(user, 'slow task')
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.keyboard('{Escape}')
    gate.resolve()
    await waitFor(() => expect(openTarget).toHaveBeenCalled())
    expect(await screen.findByText('my-api › slow task')).toBeInTheDocument()
  })

  it('keeps a dialog opened while a commit was running', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const api = repoApi()
    const commitAll = api.commitAll
    api.commitAll = async (...args) => {
      await gate.promise
      return commitAll(...args)
    }
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(within(screen.getByRole('group', { name: 'Git' })).getByRole('button', { name: 'Commit all…' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Commit all in fix login bug' }))
    await dialog.findByText('3 files will be committed')
    await user.type(dialog.getByRole('textbox', { name: 'Commit message' }), 'wip')
    await user.click(dialog.getByRole('button', { name: 'Commit' }))
    await user.click(dialog.getByRole('textbox', { name: 'Commit message' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    gate.resolve()
    expect(await screen.findByText('Committed 3 files')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('reports conflicts in a toast instead of replacing a dialog opened while the update ran', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const api = repoApi()
    const updateFromBase = api.updateFromBase
    api.updateFromBase = async (...args) => {
      await gate.promise
      return updateFromBase(...args)
    }
    render(<App api={api} />)
    await createRepoAndTask(user, 'conflict demo')
    await user.click(
      within(screen.getByRole('group', { name: 'Git' })).getByRole('button', { name: 'Update from base' }),
    )
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    gate.resolve()
    expect(await screen.findByText(/stopped on conflicts in 2 files and was undone/)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('App archiving tasks', () => {
  const placeholder = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Archived task' })
  const idOf = async (api: MeManagerApi, name: string): Promise<string> => {
    const repo = (await api.getState()).themes[0].items[0]
    return (repo.kind === 'repo' && repo.tasks.find((t) => t.name === name)?.id) || ''
  }
  const openPalette = async (): Promise<HTMLElement> => {
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    return screen.findByRole('dialog', { name: 'Command palette' })
  }
  const optionNames = (dialog: HTMLElement): (string | null)[] =>
    within(dialog)
      .getAllByRole('option')
      .map((o) => o.getAttribute('aria-label'))

  it('archives a clean task from its row without asking, and shows it archived in place of the terminal', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const archiveTask = vi.spyOn(api, 'archiveTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive task fix login bug' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(archiveTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), false)
    const region = await placeholder()
    expect(region).toHaveTextContent('“fix login bug” is archived')
    expect(region).toHaveTextContent('claude/client-x/fix-login-bug')
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(\S )?fix login bug$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '▶ Archived (1)' })).toBeInTheDocument()
    expect(await screen.findByText('Archived “fix login bug”')).toBeInTheDocument()
  })

  it('asks before archiving a task with uncommitted files, and discards them only once confirmed', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      checkTaskRemoval: async () => ({ uncommittedFiles: ['src/login.ts'], unpushedCommits: [] }),
    })
    const archiveTask = vi.spyOn(api, 'archiveTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Archive task fix login bug' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'Archive fix login bug' })
    expect(within(dialog).getByText('src/login.ts')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(archiveTask).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Archive task fix login bug' }))
    dialog = await screen.findByRole('alertdialog', { name: 'Archive fix login bug' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive anyway (discards changes)' }))
    expect(archiveTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(await placeholder()).toBeInTheDocument()
  })

  it("shows main's refusal and keeps the task as it was", async () => {
    const user = userEvent.setup()
    const api = repoApi({
      archiveTask: async () => {
        throw new Error('"fix login bug" has 1 uncommitted or untracked file. Commit or discard the changes first')
      },
    })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Archive task fix login bug' }))
    expect(await screen.findByText(/Commit or discard the changes first/)).toBeInTheDocument()
    expect(taskButton('fix login bug')).toBeInTheDocument()
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
  })

  it('restores from the placeholder, then opens the task, starting its session lazily', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const unarchiveTask = vi.spyOn(api, 'unarchiveTask')
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Archive task fix login bug' }))
    const region = await placeholder()
    openTarget.mockClear()
    await user.click(within(region).getByRole('button', { name: 'Restore' }))
    const taskId = await idOf(api, 'fix login bug')
    expect(unarchiveTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), taskId)
    expect(await screen.findByTestId('terminal')).toBeInTheDocument()
    expect(openTarget).toHaveBeenCalledWith(expect.objectContaining({ taskId }))
    expect(screen.queryByRole('button', { name: /Archived/ })).not.toBeInTheDocument()
    expect(taskButton('fix login bug')).toBeInTheDocument()
  })

  it('restores and deletes from the Archived group, which starts collapsed and is remembered', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      checkTaskRemoval: async () => ({ uncommittedFiles: [], unpushedCommits: ['abc1234 wip'] }),
    })
    const unarchiveTask = vi.spyOn(api, 'unarchiveTask')
    const removeTask = vi.spyOn(api, 'removeTask')
    const openTarget = vi.spyOn(api, 'openTarget')
    const saveUiState = vi.spyOn(api, 'saveUiState')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B', 'task C') // task C is selected
    await user.click(screen.getByRole('button', { name: 'Archive task task A' }))
    await user.click(screen.getByRole('button', { name: 'Archive task task B' }))
    const group = await screen.findByRole('button', { name: '▶ Archived (2)' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Restore task task A' })).not.toBeInTheDocument()
    await user.click(group)
    const repoId = (await api.getState()).themes[0].items[0].id
    await waitFor(() => expect(saveUiState.mock.lastCall?.[0].archivedOpen).toEqual([repoId]))

    openTarget.mockClear()
    await user.click(screen.getByRole('button', { name: 'Restore task task A' }))
    expect(unarchiveTask).toHaveBeenCalledWith(expect.any(String), repoId, await idOf(api, 'task A'))
    expect(await screen.findByText('Restored “task A”')).toBeInTheDocument()
    expect(taskButton('task A')).toBeInTheDocument()
    expect(openTarget).not.toHaveBeenCalled() // not selected: its session starts when it is opened
    expect(screen.getByText('my-api › task C')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete archived task task B' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete archived task task B' })
    expect(dialog).toHaveTextContent('claude/client-x/task-b')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('1 commit that is not on origin/main or pushed')
    expect(removeTask).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Delete task and branch' }))
    const taskB = (await api.getState()).themes[0].items[0]
    expect(taskB.kind === 'repo' && taskB.tasks.map((t) => t.name)).toEqual(['task A', 'task C'])
    expect(removeTask).toHaveBeenCalledWith(expect.any(String), repoId, expect.any(String), true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Archived/ })).not.toBeInTheDocument()
  })

  it('skips archived tasks for Alt+1..9 and the git, tab and usage polls, and never attaches to one', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const getGitStatus = vi.spyOn(api, 'getGitStatus')
    const openTarget = vi.spyOn(api, 'openTarget')
    const listTabs = vi.spyOn(api, 'listTabs')
    const getUsage = vi.spyOn(api, 'getUsage')
    const detachTerminal = vi.spyOn(api, 'detachTerminal')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B', 'task C') // task C is selected
    await user.click(screen.getByRole('button', { name: 'Archive task task A' }))
    await screen.findByRole('button', { name: '▶ Archived (1)' })
    const archivedId = await idOf(api, 'task A')
    for (const spy of [getGitStatus, openTarget, listTabs, getUsage]) spy.mockClear() // it was opened when created
    fireEvent.keyDown(window, { key: '1', altKey: true })
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()
    await waitFor(() => expect(getGitStatus.mock.lastCall?.[0].map((t) => t.taskId)).toHaveLength(2))
    expect(getGitStatus.mock.lastCall?.[0].map((t) => t.taskId)).not.toContain(archivedId)

    await user.click(screen.getByRole('button', { name: '▶ Archived (1)' }))
    await user.click(screen.getByRole('button', { name: 'task A' }))
    expect(await placeholder()).toHaveTextContent('“task A” is archived')
    expect(detachTerminal).toHaveBeenCalled() // task B's terminal no longer shown, so it isn't "selected" in main
    await act(async () => {
      fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true }) // new tab: nothing to open it in
    })
    const touched = (spy: { mock: { calls: unknown[][] } }): boolean =>
      spy.mock.calls.some((args) => (args[0] as Target | undefined)?.taskId === archivedId)
    expect(touched(openTarget)).toBe(false)
    expect(touched(listTabs)).toBe(false)
    expect(touched(getUsage)).toBe(false)
    expect(getGitStatus.mock.calls.some((args) => args[0].some((t) => t.taskId === archivedId))).toBe(false)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('archives the current task from the palette, and offers only Restore and Delete for an archived one', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const archiveTask = vi.spyOn(api, 'archiveTask')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    let dialog = await openPalette()
    await user.type(screen.getByRole('combobox'), 'archive current')
    expect(optionNames(dialog)[0]).toBe('Archive current task')
    await user.keyboard('{Enter}')
    expect(archiveTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), await idOf(api, 'task B'), false)
    await placeholder()

    dialog = await openPalette()
    const names = optionNames(dialog)
    expect(names).toEqual(expect.arrayContaining(['Restore archived task', 'Delete archived task…']))
    for (const name of ['Archive current task', 'New shell tab', 'Git: Push branch', 'Toggle files panel'])
      expect(names).not.toContain(name)
    expect(names).not.toContain('Client X › my-api › task B') // archived tasks are not jump targets
    await user.type(screen.getByRole('combobox'), 'restore archived')
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('terminal')).toBeInTheDocument()
  })

  it('restores a saved selection that is archived as the placeholder, with its group open, without opening it', async () => {
    const api = repoApi()
    const themeId = (await api.createTheme('Client X')).themes[0].id
    const repoId = (await api.addRepo(themeId, '/home/me/code/my-api')).themes[0].items[0].id
    await api.createTask(themeId, repoId, 'task A')
    const taskId = await idOf(api, 'task A')
    await api.archiveTask(themeId, repoId, taskId)
    await api.saveUiState({
      version: 1,
      selected: { themeId, itemId: repoId, taskId },
      collapsed: [],
      panels: {},
      archivedOpen: [repoId],
    })
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    expect(await placeholder()).toHaveTextContent('“task A” is archived')
    expect(screen.getByRole('button', { name: '▼ Archived (1)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'task A' }).closest('.row')).toHaveClass('selected')
    expect(openTarget).not.toHaveBeenCalled()
  })
})

describe('App run command', () => {
  const runGroup = (): HTMLElement => screen.getByRole('group', { name: 'Run' })
  const statusBar = (): HTMLElement => screen.getByRole('group', { name: 'Status bar' })

  async function setCommand(user: UserEvent, command: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Run command for my-api…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run command for my-api' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Command' }), command)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  }

  it("sets a repo's run command from the sidebar, then runs, stops and restarts it from the header", async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const setRunCommand = vi.spyOn(api, 'setRunCommand')
    const startRun = vi.spyOn(api, 'startRun')
    const stopRun = vi.spyOn(api, 'stopRun')
    const restartRun = vi.spyOn(api, 'restartRun')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(within(runGroup()).getByRole('button', { name: 'Set run command…' })).toBeInTheDocument()
    await setCommand(user, 'npm run dev')
    const state = await api.getState()
    expect(setRunCommand).toHaveBeenCalledWith(state.themes[0].id, state.themes[0].items[0].id, 'npm run dev')
    expect(await screen.findByRole('status')).toHaveTextContent('Saved the run command of my-api')

    await user.click(within(runGroup()).getByRole('button', { name: 'Start npm run dev' }))
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }))
    expect(await screen.findByRole('tab', { name: 'run' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Run: running')).toBeInTheDocument()
    expect(within(statusBar()).getByRole('button', { name: 'Run tab running: show it' })).toBeInTheDocument()

    await user.click(within(runGroup()).getByRole('button', { name: 'Stop run' }))
    expect(stopRun).toHaveBeenCalledTimes(1)
    expect(await screen.findByLabelText('Run: stopped')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'run' })).toHaveClass('dead')

    await user.click(within(runGroup()).getByRole('button', { name: 'Restart run' }))
    expect(restartRun).toHaveBeenCalledTimes(1)
    expect(await screen.findByLabelText('Run: running')).toBeInTheDocument()
  })

  it('runs, restarts and stops from the palette, and edits the command there', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const startRun = vi.spyOn(api, 'startRun')
    const restartRun = vi.spyOn(api, 'restartRun')
    const stopRun = vi.spyOn(api, 'stopRun')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const runFromPalette = async (label: string): Promise<void> => {
      fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
      await user.type(await screen.findByRole('combobox'), label)
      expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(label)
      await user.keyboard('{Enter}')
    }
    await runFromPalette('Set run command…')
    await user.type(await screen.findByRole('textbox', { name: 'Command' }), 'pnpm dev')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await runFromPalette('Run pnpm dev')
    expect(startRun).toHaveBeenCalledTimes(1)
    await screen.findByLabelText('Run: running')
    await runFromPalette('Stop the run command')
    expect(stopRun).toHaveBeenCalledTimes(1)
    await screen.findByLabelText('Run: stopped')
    await runFromPalette('Restart the run command')
    expect(restartRun).toHaveBeenCalledTimes(1)
    await runFromPalette('Edit run command…')
    expect(await screen.findByRole('textbox', { name: 'Command' })).toHaveValue('pnpm dev')
  })

  it('restarts and stops from the run tab menu, and shows the run tab from the status bar', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const restartRun = vi.spyOn(api, 'restartRun')
    const stopRun = vi.spyOn(api, 'stopRun')
    const startRun = vi.spyOn(api, 'startRun')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await setCommand(user, 'npm start')
    await user.click(within(runGroup()).getByRole('button', { name: 'Start npm start' }))
    fireEvent.contextMenu(await screen.findByRole('tab', { name: 'run' }))
    await user.click(screen.getByRole('menuitem', { name: 'Stop' }))
    expect(stopRun).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(await screen.findByRole('tab', { name: 'run' }))
    await user.click(screen.getByRole('menuitem', { name: 'Restart' }))
    expect(restartRun).toHaveBeenCalledTimes(1)
    await user.click(within(statusBar()).getByRole('button', { name: /^Run tab .*: show it$/ }))
    expect(startRun).toHaveBeenCalledTimes(2)
  })

  it('shows why Run failed', async () => {
    const user = userEvent.setup()
    render(
      <App
        api={repoApi({
          startRun: async () => {
            throw new Error('Open the task first: its session is not running')
          },
        })}
      />,
    )
    await createRepoAndTask(user)
    await setCommand(user, 'npm start')
    await user.click(within(runGroup()).getByRole('button', { name: 'Start npm start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Open the task first: its session is not running')
  })
})

describe('App dev-server links', () => {
  const RUN_TABS: TabInfo[] = [
    { index: 0, name: 'claude', active: false },
    { index: 1, name: 'run', active: true },
  ]
  const VITE = { url: 'http://localhost:5173/', index: 1, tab: 'run' }

  it("polls the selected target's URLs and opens one in the browser from the header and the status bar", async () => {
    const user = userEvent.setup()
    const getDevUrls = vi.fn(async () => [VITE])
    const api = repoApi({ getDevUrls, openTarget: async () => RUN_TABS, listTabs: async () => RUN_TABS })
    const openExternal = vi.spyOn(api, 'openExternal')
    render(<App api={api} />)
    await createRepoAndTask(user)
    const header = await screen.findByRole('group', { name: 'Dev-server links' })
    expect(getDevUrls).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }))
    await user.click(within(header).getByRole('link', { name: 'localhost:5173' }))
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/')
    const bar = screen.getByRole('group', { name: 'Status bar' })
    await user.click(within(bar).getByRole('link', { name: 'localhost:5173' }))
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('opens a URL from the palette', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      getDevUrls: async () => [VITE],
      openTarget: async () => RUN_TABS,
      listTabs: async () => RUN_TABS,
    })
    const openExternal = vi.spyOn(api, 'openExternal')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await screen.findByRole('group', { name: 'Dev-server links' })
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    await user.type(await screen.findByRole('combobox'), 'Open http://localhost:5173/')
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName('Open http://localhost:5173/')
    await user.keyboard('{Enter}')
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('hides a URL as soon as its tab closes', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      getDevUrls: async () => [VITE],
      openTarget: async () => RUN_TABS,
      listTabs: async () => RUN_TABS,
      closeTab: async () => [RUN_TABS[0]],
    })
    render(<App api={api} />)
    await createRepoAndTask(user)
    await screen.findByRole('group', { name: 'Dev-server links' })
    await user.click(screen.getByRole('button', { name: 'Close tab run' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Dev-server links' })).not.toBeInTheDocument())
  })

  it("never shows another task's URLs, even before the new one's have loaded", async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const nameOf = async (target: Target): Promise<string | undefined> => {
      const repo = (await api.getState()).themes[0].items[0]
      return repo.kind === 'repo' ? repo.tasks.find((t) => t.id === target.taskId)?.name : undefined
    }
    const api: MeManagerApi = repoApi({
      openTarget: async () => RUN_TABS,
      listTabs: async () => RUN_TABS,
      getDevUrls: async (target) => {
        if ((await nameOf(target)) === 'task A') return [VITE]
        await gate.promise // task B's answer is late
        return []
      },
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task B', 'task A') // task A is selected
    await screen.findByRole('group', { name: 'Dev-server links' })
    await user.click(taskButton('task B'))
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Dev-server links' })).not.toBeInTheDocument()
    gate.resolve()
  })

  it('shows the error when the browser could not be opened', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      getDevUrls: async () => [VITE],
      openTarget: async () => RUN_TABS,
      listTabs: async () => RUN_TABS,
      openExternal: async () => {
        throw new Error('Only http(s) links can be opened')
      },
    })
    render(<App api={api} />)
    await createRepoAndTask(user)
    const header = await screen.findByRole('group', { name: 'Dev-server links' })
    await user.click(within(header).getByRole('link', { name: 'localhost:5173' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only http(s) links can be opened')
  })
})

describe('App reordering', () => {
  /** The sidebar's active tasks, top to bottom. */
  const taskNames = (): string[] =>
    [...document.querySelectorAll('.task-row .row-label')].map((b) => b.textContent?.replace(/^\S /u, '') ?? '')
  const rowOf = (name: string): HTMLElement => taskButton(name).closest('.row') as HTMLElement
  const dataTransfer = (): Pick<DataTransfer, 'dropEffect' | 'effectAllowed' | 'setData' | 'getData'> => ({
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: vi.fn(),
    getData: vi.fn(() => ''),
  })
  /** Drags task `name` onto the top half of task `onto` (jsdom's rows are 0px high at y = 0: above 0 is "before"). */
  const dragOnto = (name: string, onto: string): void => {
    const dt = dataTransfer()
    fireEvent.dragStart(rowOf(name), { dataTransfer: dt })
    for (const type of ['dragOver', 'drop'] as const) {
      const event = createEvent[type](rowOf(onto), { dataTransfer: dt })
      Object.defineProperty(event, 'clientY', { value: -1 })
      fireEvent(rowOf(onto), event)
    }
  }
  const altShift = (key: 'ArrowUp' | 'ArrowDown'): KeyboardEventInit => ({ key, altKey: true, shiftKey: true })

  it('moves a dropped task at once and saves it; Alt+1..9 follows the new order', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const moveTask = vi.spyOn(api, 'moveTask')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    await user.click(taskButton('task A'))
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()

    dragOnto('task B', 'task A')
    expect(taskNames()).toEqual(['task B', 'task A'])
    expect(moveTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 0)
    await waitFor(async () =>
      expect((await api.getState()).themes[0].items[0]).toMatchObject({
        tasks: [{ name: 'task B' }, { name: 'task A' }],
      }),
    )
    fireEvent.keyDown(window, { key: '1', altKey: true })
    expect(await screen.findByText('my-api › task B')).toBeInTheDocument()
  })

  it('puts the order back and shows the error when main refuses the move', async () => {
    const user = userEvent.setup()
    let refuse: (err: Error) => void = () => {}
    const api = repoApi({
      moveTask: () => new Promise((_, reject) => (refuse = reject)),
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    dragOnto('task B', 'task A')
    expect(taskNames()).toEqual(['task B', 'task A'])
    act(() => refuse(new Error("Error invoking remote method 'api:moveTask': Error: Task not found: x")))
    expect(await screen.findByRole('alert')).toHaveTextContent('Task not found: x')
    await waitFor(() => expect(taskNames()).toEqual(['task A', 'task B']))
  })

  it('moves the focused task with Alt+Shift+↑/↓ and announces where it went', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const moveTask = vi.spyOn(api, 'moveTask')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B', 'task C')
    taskButton('task A').focus()
    fireEvent.keyDown(taskButton('task A'), altShift('ArrowDown'))
    expect(taskNames()).toEqual(['task B', 'task A', 'task C'])
    const announcer = screen.getByTestId('announcer')
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer).toHaveTextContent('Moved task A to position 2 of 3')
    expect(moveTask).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.any(String), 1)
    await waitFor(() => expect(taskButton('task A')).toHaveFocus())

    fireEvent.keyDown(taskButton('task C'), altShift('ArrowUp'))
    expect(announcer).toHaveTextContent('Moved task C to position 2 of 3')
    await waitFor(() => expect(taskNames()).toEqual(['task B', 'task C', 'task A']))
  })

  it('moves on from the shown order when keys come faster than main answers', async () => {
    const user = userEvent.setup()
    const gates = [deferred(), deferred()]
    const api = repoApi()
    const moveTask = api.moveTask
    vi.spyOn(api, 'moveTask').mockImplementation(async (...args) => {
      const answer = moveTask(...args) // main applies the moves in order, answering each when its gate opens
      await gates[vi.mocked(api.moveTask).mock.calls.length - 1].promise
      return answer
    })
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B', 'task C')
    fireEvent.keyDown(taskButton('task A'), altShift('ArrowDown'))
    fireEvent.keyDown(taskButton('task A'), altShift('ArrowDown'))
    expect(taskNames()).toEqual(['task B', 'task C', 'task A'])
    expect(vi.mocked(api.moveTask).mock.calls.map((c) => c[3])).toEqual([1, 2])
    await act(async () => gates[0].resolve()) // the first answer lacks the second move: not shown
    expect(taskNames()).toEqual(['task B', 'task C', 'task A'])
    await act(async () => gates[1].resolve())
    expect(taskNames()).toEqual(['task B', 'task C', 'task A'])
  })

  it('offers "Move task up/down" for the current task in the palette, where there is room', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await createRepoAndTask(user, 'task A', 'task B') // task B is selected
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(dialog).queryByRole('option', { name: 'Move task down' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('option', { name: 'Move task up' }))
    expect(taskNames()).toEqual(['task B', 'task A'])
    expect(screen.getByTestId('announcer')).toHaveTextContent('Moved task B to position 1 of 2')

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const again = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(again).queryByRole('option', { name: 'Move task up' })).not.toBeInTheDocument()
    expect(within(again).getByRole('option', { name: 'Move task down' })).toBeInTheDocument()
  })

  it('turns dragging off and says to clear the filter while the sidebar is filtered', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const moveTask = vi.spyOn(api, 'moveTask')
    render(<App api={api} />)
    await createRepoAndTask(user, 'task A', 'task B')
    await user.type(screen.getByRole('textbox', { name: 'Filter sidebar' }), 'task')
    expect(rowOf('task A')).toHaveAttribute('draggable', 'false')
    fireEvent.keyDown(taskButton('task A'), altShift('ArrowDown'))
    expect(screen.getByTestId('announcer')).toHaveTextContent('Clear the filter to move rows')
    expect(moveTask).not.toHaveBeenCalled()
  })
})

describe('App bulk actions', () => {
  const bar = (): ReturnType<typeof within> => within(screen.getByRole('toolbar', { name: 'Selected tasks' }))
  const dialog = (name: string): ReturnType<typeof within> => within(screen.getByRole('alertdialog', { name }))
  /** The tasks a bulk confirmation lists (their items hold lists of their own: files, commits). */
  const taskItems = (d: ReturnType<typeof within>): HTMLElement[] =>
    [...d.getByRole('list', { name: 'Tasks' }).children] as HTMLElement[]
  const listed = (d: ReturnType<typeof within>): string[] =>
    taskItems(d).map((li) => li.querySelector('.bulk-task-name')?.textContent ?? '')
  /** The task's name, from main's state. */
  const nameOf = async (api: MeManagerApi, target: Target): Promise<string> => {
    const repo = (await api.getState()).themes.flatMap((t) => t.items).find((i) => i.id === target.itemId)
    return repo?.kind === 'repo' ? (repo.tasks.find((k) => k.id === target.taskId)?.name ?? '?') : '?'
  }
  /** Creates the tasks (the last one is opened), then Ctrl+clicks the others into the selection with it. */
  async function selectAll(user: UserEvent, ...names: string[]): Promise<void> {
    await createRepoAndTask(user, ...names)
    await user.keyboard('{Control>}')
    for (const name of names.slice(0, -1)) await user.click(taskButton(name))
    await user.keyboard('{/Control}')
    expect(bar().getByText(`${names.length} tasks selected`)).toBeInTheDocument()
  }

  it('pushes the selected tasks after one confirmation listing them, and sums up a partial failure', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const push = api.pushTask
    const pushTask = vi.fn<MeManagerApi['pushTask']>(async (target) => {
      if ((await nameOf(api, target)) === 'task B')
        throw new Error("Error invoking remote method 'api:pushTask': Error: git push failed: ! [rejected]")
      return push(target)
    })
    api.pushTask = pushTask
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B', 'task C')
    await user.click(bar().getByRole('button', { name: 'Push the selected tasks…' }))
    const confirm = dialog('Push 3 tasks')
    expect(listed(confirm)).toEqual(['task A', 'task B', 'task C'])
    expect(confirm.getByText('claude/client-x/task-b')).toBeInTheDocument()
    expect(pushTask).not.toHaveBeenCalled()
    await user.click(confirm.getByRole('button', { name: 'Push 3 tasks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pushed 2 of 3 tasks; task B failed: git push failed: ! [rejected]',
    )
    expect(pushTask).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(bar().getByText('3 tasks selected')).toBeInTheDocument() // kept, for another action
  })

  it('says when every push went through, and Cancel or Esc pushes nothing', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const pushTask = vi.spyOn(api, 'pushTask')
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B')
    await user.click(bar().getByRole('button', { name: 'Push the selected tasks…' }))
    await user.click(dialog('Push 2 tasks').getByRole('button', { name: 'Cancel' }))
    await user.click(bar().getByRole('button', { name: 'Push the selected tasks…' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(pushTask).not.toHaveBeenCalled()
    await user.click(bar().getByRole('button', { name: 'Push the selected tasks…' }))
    await user.click(dialog('Push 2 tasks').getByRole('button', { name: 'Push 2 tasks' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Pushed 2 tasks')
  })

  it('shows the batch running in the bar, with its actions off, until it ends', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    const api = repoApi()
    const push = api.pushTask
    api.pushTask = async (target) => {
      await gate.promise
      return push(target)
    }
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B')
    await user.click(bar().getByRole('button', { name: 'Push the selected tasks…' }))
    await user.click(dialog('Push 2 tasks').getByRole('button', { name: 'Push 2 tasks' }))
    expect(bar().getByText('Pushing 2 tasks…')).toBeInTheDocument()
    for (const b of bar().getAllByRole('button')) expect(b).toBeDisabled()
    expect(
      within(screen.getByRole('group', { name: 'Git' })).getByRole('button', { name: 'Push branch' }),
    ).toBeDisabled()
    await act(async () => gate.resolve())
    expect(await screen.findByRole('status')).toHaveTextContent('Pushed 2 tasks')
    expect(bar().getByText('2 tasks selected')).toBeInTheDocument()
    expect(bar().getByRole('button', { name: 'Clear the selection' })).toBeEnabled()
  })

  it('updates from base with the configured strategy, naming conflicts and failures without a dialog for each', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    await api.updateSettings({ updateStrategy: 'merge' })
    const update = api.updateFromBase
    const updateFromBase = vi.fn<MeManagerApi['updateFromBase']>(async (target) => {
      if ((await nameOf(api, target)) === 'task C') throw new Error('Commit or stash your changes first')
      return update(target)
    })
    api.updateFromBase = updateFromBase
    render(<App api={api} />)
    await selectAll(user, 'task A', 'conflict demo', 'task C')
    await user.click(bar().getByRole('button', { name: 'Update the selected tasks from base…' }))
    const confirm = dialog('Update 3 tasks')
    expect(confirm.getByText(/git merge --no-edit/)).toBeInTheDocument()
    await user.click(confirm.getByRole('button', { name: 'Update 3 tasks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Updated 1 of 3 tasks; conflicts in conflict demo (undone: run Update from base on it to resolve); task C failed: Commit or stash your changes first',
    )
    expect(updateFromBase).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('archives the selected tasks, skipping one with uncommitted files, as it would lose them', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    api.checkTaskRemoval = async (_themeId, repoId, taskId) =>
      (await nameOf(api, { themeId: '', itemId: repoId, taskId })) === 'task B'
        ? { uncommittedFiles: ['src/b.ts'], unpushedCommits: [] }
        : { uncommittedFiles: [], unpushedCommits: [] }
    const archiveTask = vi.spyOn(api, 'archiveTask')
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B', 'task C')
    await user.click(bar().getByRole('button', { name: 'Archive the selected tasks…' }))
    const confirm = dialog('Archive 3 tasks')
    expect(listed(confirm)).toEqual(['task A', 'task B', 'task C'])
    expect(confirm.getByText(/Skipped: it has uncommitted or untracked files/)).toBeInTheDocument()
    expect(confirm.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(confirm.getByRole('button', { name: 'Archive 2 tasks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Archived 2 of 3 tasks; skipped task B: it has uncommitted or untracked files',
    )
    expect(archiveTask).toHaveBeenCalledTimes(2)
    for (const call of archiveTask.mock.calls) expect(call[3]).toBe(false) // never forced
    expect(screen.getByRole('button', { name: '▶ Archived (2)' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument() // one task left selected
  })

  it('offers Restore after archiving them all, which brings them back', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const unarchiveTask = vi.spyOn(api, 'unarchiveTask')
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B')
    await user.click(bar().getByRole('button', { name: 'Archive the selected tasks…' }))
    await user.click(dialog('Archive 2 tasks').getByRole('button', { name: 'Archive 2 tasks' }))
    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Archived 2 tasks')
    await user.click(within(toast).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Restored 2 tasks'))
    expect(unarchiveTask).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /Archived/ })).not.toBeInTheDocument()
  })

  it('removes the selected tasks, showing unsaved work per task and offering to delete their branches', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const work: Record<string, UnsavedWork> = {
      'task A': { uncommittedFiles: ['src/a.ts'], unpushedCommits: [] },
      'task B': { uncommittedFiles: [], unpushedCommits: ['abc123 wip'] },
    }
    api.checkTaskRemoval = async (_themeId, repoId, taskId) =>
      work[await nameOf(api, { themeId: '', itemId: repoId, taskId })] ?? { uncommittedFiles: [], unpushedCommits: [] }
    const remove = api.removeTask
    const removeTask = vi.fn<MeManagerApi['removeTask']>(async (themeId, repoId, taskId, deleteBranch) => {
      if ((await nameOf(api, { themeId, itemId: repoId, taskId })) === 'task B') throw new Error('worktree is locked')
      return remove(themeId, repoId, taskId, deleteBranch)
    })
    api.removeTask = removeTask
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B', 'task C')
    await user.click(bar().getByRole('button', { name: 'Remove the selected tasks…' }))
    const confirm = dialog('Remove 3 tasks')
    const items = taskItems(confirm)
    expect(listed(confirm)).toEqual(['task A', 'task B', 'task C'])
    expect(within(items[0]).getByText('src/a.ts')).toBeInTheDocument()
    expect(within(items[0]).getByText('1 uncommitted file')).toBeInTheDocument()
    expect(within(items[1]).getByText('abc123 wip')).toBeInTheDocument()
    expect(within(items[2]).getByText(/No unsaved work/)).toBeInTheDocument()
    const deleteBranches = confirm.getByRole('checkbox', { name: 'Also delete the branches' })
    expect(deleteBranches).not.toBeChecked() // as for one task with unsaved work
    await user.click(deleteBranches)
    expect(removeTask).not.toHaveBeenCalled()
    await user.click(confirm.getByRole('button', { name: 'Remove 3 tasks anyway' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Removed 2 of 3 tasks; task B failed: worktree is locked',
    )
    expect(removeTask.mock.calls.map((c) => c[3])).toEqual([true, true, true])
    expect(screen.queryByRole('button', { name: /task A$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /task C$/ })).not.toBeInTheDocument()
    expect(taskButton('task B')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument() // task C, the open one, is gone
  })

  it('deletes the branches of clean tasks by default, as for one task', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const removeTask = vi.spyOn(api, 'removeTask')
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B')
    await user.click(bar().getByRole('button', { name: 'Remove the selected tasks…' }))
    const confirm = dialog('Remove 2 tasks')
    expect(confirm.getAllByText(/No unsaved work/)).toHaveLength(2)
    expect(confirm.getByRole('checkbox', { name: 'Also delete the branches' })).toBeChecked()
    await user.click(confirm.getByRole('button', { name: 'Remove 2 tasks' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Removed 2 tasks')
    expect(removeTask.mock.calls.map((c) => c[3])).toEqual([true, true])
  })

  it('says a task could not be checked for unsaved work', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    api.checkTaskRemoval = async () => Promise.reject(new Error('the repository is gone'))
    render(<App api={api} />)
    await selectAll(user, 'task A', 'task B')
    await user.click(bar().getByRole('button', { name: 'Remove the selected tasks…' }))
    const confirm = dialog('Remove 2 tasks')
    expect(confirm.getAllByText(/Could not fully check: the repository is gone/)).toHaveLength(2)
    expect(confirm.getByRole('checkbox', { name: 'Also delete the branches' })).not.toBeChecked()
  })

  it('offers the bulk actions in the palette while tasks are selected, and clears the selection there', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await selectAll(user, 'task A', 'task B')
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const palette = within(await screen.findByRole('dialog', { name: 'Command palette' }))
    await user.type(palette.getByRole('combobox'), 'select')
    expect(palette.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([
        'Push the 2 selected tasks…',
        'Update the 2 selected tasks from base…',
        'Archive the 2 selected tasks…',
        'Remove the 2 selected tasks…',
        'Clear the task selection',
      ]),
    )
    await user.clear(palette.getByRole('combobox'))
    await user.type(palette.getByRole('combobox'), 'archive the 2')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('alertdialog', { name: 'Archive 2 tasks' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const again = within(await screen.findByRole('dialog', { name: 'Command palette' }))
    await user.type(again.getByRole('combobox'), 'clear the task selection')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })
    const none = within(await screen.findByRole('dialog', { name: 'Command palette' }))
    await user.type(none.getByRole('combobox'), 'selected tasks')
    expect(none.queryByRole('option', { name: /selected tasks/ })).not.toBeInTheDocument()
  })

  it('keeps a plain click opening one task and clearing the selection, and Esc clearing it', async () => {
    const user = userEvent.setup()
    render(<App api={repoApi()} />)
    await selectAll(user, 'task A', 'task B')
    await user.click(taskButton('task A'))
    expect(await screen.findByText('my-api › task A')).toBeInTheDocument()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    await user.keyboard('{Control>}')
    await user.click(taskButton('task B'))
    await user.keyboard('{/Control}')
    expect(bar().getByText('2 tasks selected')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})
