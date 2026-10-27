import { act, createEvent, fireEvent, render, screen, within, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveStatus, TaskGitStatus } from '../../../shared/types'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { budgetStatus } from '../../../shared/budget'
import { Sidebar, type SidebarProps } from './Sidebar'

const state = appState(theme('Client', [repo('api', [task('fix'), task('docs')]), folder('notes')]))

/** Every prop, with no-op callbacks, and `patch` on top. */
function sidebarProps(patch: Partial<SidebarProps> = {}): SidebarProps {
  const status: LiveStatus = { running: [], missing: [], activity: {} }
  return {
    state,
    status,
    selected: null,
    collapsed: new Set(),
    onToggleCollapsed: vi.fn(),
    filter: '',
    onFilterChange: vi.fn(),
    onSelect: vi.fn(),
    onAddTheme: vi.fn(),
    onRenameTheme: vi.fn(),
    onCustomizeTheme: vi.fn(),
    onRemoveTheme: vi.fn(),
    onAddRepo: vi.fn(),
    onCloneRepo: vi.fn(),
    onAddFolder: vi.fn(),
    onRemoveItem: vi.fn(),
    onAddTask: vi.fn(),
    onRenameTask: vi.fn(),
    onRemoveTask: vi.fn(),
    onArchiveTask: vi.fn(),
    onToggleArchived: vi.fn(),
    onRestoreTask: vi.fn(),
    onDeleteArchivedTask: vi.fn(),
    onEditRunCommand: vi.fn(),
    onMove: vi.fn(),
    multiSelection: new Set(),
    onMultiSelect: vi.fn(),
    onBulkAction: vi.fn(),
    onAnnounce: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenUsage: vi.fn(),
    ...patch,
  }
}

function renderSidebar(patch: Partial<SidebarProps> = {}): RenderResult {
  return render(<Sidebar {...sidebarProps(patch)} />)
}

const git = (patch: Partial<TaskGitStatus>): TaskGitStatus => ({
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  branch: 'b/fix',
  ...patch,
})

describe('Sidebar header and tree', () => {
  it('starts a new task from the New task button, shown only with onNewTask', async () => {
    const onNewTask = vi.fn()
    const { unmount } = renderSidebar({ onNewTask })
    expect(screen.getByText('me-manager')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'New task' }))
    expect(onNewTask).toHaveBeenCalledTimes(1)
    unmount()
    renderSidebar()
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument()
  })

  it('marks tasks and folders whose Claude finished unseen, keeping their names', () => {
    renderSidebar({ unread: new Set(['fix', 'notes']) })
    expect(screen.getByRole('button', { name: '○ fix, new' }).querySelector('.unread-mark')).toHaveAttribute(
      'title',
      'Claude finished here since you last looked',
    )
    expect(screen.getByRole('button', { name: '○ notes, new' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '○ docs' })).toBeInTheDocument()
  })

  it("shows the full names, cut short in a narrow sidebar, in the rows' tooltips, with paths and notes", () => {
    const noted = { ...task('fix'), notes: 'Ask about the token refresh' }
    const archived = { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z', notes: 'Shipped' }
    renderSidebar({
      state: appState(theme('Client', [repo('api', [noted, task('docs'), archived]), folder('notes')])),
      archivedOpen: new Set(['api']),
      status: { running: [], missing: ['api'], activity: {} },
    })
    expect(screen.getByRole('button', { name: 'Client' })).toHaveAttribute('title', 'Client')
    expect(screen.getByRole('button', { name: '⚠ api' })).toHaveAttribute('title', 'api\n/code/api (missing)')
    expect(screen.getByRole('button', { name: '○ notes' })).toHaveAttribute('title', 'notes\n/f/notes')
    expect(screen.getByRole('button', { name: '○ fix' })).toHaveAttribute('title', 'fix\nAsk about the token refresh')
    expect(screen.getByRole('button', { name: '○ docs' })).toHaveAttribute('title', 'docs')
    expect(screen.getByRole('button', { name: 'old' })).toHaveAttribute('title', 'old\nShipped')
    expect(screen.getByTitle('Path missing')).toHaveTextContent('⚠')
  })

  it('tells screen readers which task or folder is open', () => {
    const archived = { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z' }
    const withArchived = appState(
      theme('Client', [repo('api', [task('fix'), task('docs'), archived]), folder('notes')]),
    )
    const current = (): string[] =>
      [...document.querySelectorAll('[aria-current]')].map((el) => `${el.textContent?.trim()}=${el.ariaCurrent}`)
    const { rerender } = renderSidebar({ selected: { themeId: 'Client', itemId: 'api', taskId: 'fix' } })
    expect(current()).toEqual(['○ fix=true'])
    rerender(<Sidebar {...sidebarProps({ selected: { themeId: 'Client', itemId: 'notes' } })} />)
    expect(screen.getByRole('button', { name: '○ notes' })).toHaveAttribute('aria-current', 'true')
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1)
    rerender(
      <Sidebar
        {...sidebarProps({
          state: withArchived,
          archivedOpen: new Set(['api']),
          selected: { themeId: 'Client', itemId: 'api', taskId: 'old' },
        })}
      />,
    )
    expect(current()).toEqual(['old=true'])
    rerender(<Sidebar {...sidebarProps()} />)
    expect(current()).toEqual([])
  })

  it('clears the filter from a button in it, while it holds text, keeping the focus in it', async () => {
    const user = userEvent.setup()
    function Filtered(): React.JSX.Element {
      const [filter, setFilter] = useState('fix')
      return <Sidebar {...sidebarProps({ filter, onFilterChange: setFilter })} />
    }
    render(<Filtered />)
    expect(screen.queryByRole('button', { name: '○ docs' })).not.toBeInTheDocument()
    const clear = screen.getByRole('button', { name: 'Clear filter' })
    expect(clear).toHaveAttribute('title', 'Clear filter (Esc)')
    await user.click(clear)
    const box = screen.getByRole('textbox', { name: 'Filter sidebar' })
    expect(box).toHaveValue('')
    expect(box).toHaveFocus()
    expect(screen.getByRole('button', { name: '○ docs' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filter' })).not.toBeInTheDocument()
  })

  it('says whether each theme and repository is expanded', () => {
    renderSidebar({ collapsed: new Set(['api']) })
    expect(screen.getByRole('button', { name: 'Client' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'api' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('Sidebar rail', () => {
  const rail = (patch: Partial<SidebarProps>): RenderResult =>
    renderSidebar({ rail: true, onToggleSidebar: vi.fn(), ...patch })

  it('says on its Show sidebar button how many sessions wait for the user, and how many finished unseen', () => {
    const status: LiveStatus = {
      running: ['fix', 'docs', 'notes'],
      missing: [],
      activity: { fix: 'waiting', docs: 'waiting', notes: 'idle' },
    }
    rail({ status, unread: new Set(['notes']) })
    const toggle = screen.getByRole('button', { name: 'Show sidebar, 2 waiting for you, 1 finished' })
    expect(toggle.querySelector('.rail-badge')).toHaveTextContent('2')
    expect(toggle).toHaveAttribute('title', 'Show sidebar (Ctrl+Shift+B): 2 waiting for you, 1 finished')
  })

  it('marks finished sessions alone with a dot, and nothing when all is quiet', () => {
    const { unmount } = rail({ unread: new Set(['fix']) })
    const toggle = screen.getByRole('button', { name: 'Show sidebar, 1 finished' })
    expect(toggle.querySelector('.rail-badge')).toHaveTextContent('')
    unmount()
    rail({})
    expect(screen.getByRole('button', { name: 'Show sidebar' }).querySelector('.rail-badge')).toBeNull()
  })

  it('is the same Sidebar landmark as the full sidebar', () => {
    const { unmount } = rail({})
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toHaveClass('sidebar-rail')
    unmount()
    renderSidebar()
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).not.toHaveClass('sidebar-rail')
  })
})

describe('Sidebar keyboard navigation', () => {
  const archived = { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z' }
  const navState = appState(theme('Client', [repo('api', [task('fix'), task('docs'), archived]), folder('notes')]))

  /** The Sidebar with App's part played for collapsing: themes, repos and the Archived group. */
  function Harness(props: { patch?: Partial<SidebarProps> }): React.JSX.Element {
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
    const [archivedOpen, setArchivedOpen] = useState<ReadonlySet<string>>(new Set())
    const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
      const next = new Set(set)
      if (!next.delete(id)) next.add(id)
      return next
    }
    return (
      <Sidebar
        {...sidebarProps({ state: navState, ...props.patch })}
        collapsed={collapsed}
        onToggleCollapsed={(id) => setCollapsed((c) => flip(c, id))}
        archivedOpen={archivedOpen}
        onToggleArchived={(id) => setArchivedOpen((o) => flip(o, id))}
      />
    )
  }
  const labelOf = (name: string): HTMLElement =>
    screen.getByRole('button', { name: new RegExp(`^(\\S )?${name}( \\(\\d+\\))?$`, 'u') })
  /** The row labels in the Tab order: one at a time. */
  const tabStops = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('.row-label')]
      .filter((l) => l.tabIndex === 0)
      .map((l) => l.textContent?.replace(/\s+/g, ' ').trim() ?? '')

  it('keeps one row in the Tab order: the selected one, else the first, then the one last focused', () => {
    const { unmount } = render(<Harness />)
    expect(tabStops()).toEqual(['Client'])
    unmount()
    render(<Harness patch={{ selected: { themeId: 'Client', itemId: 'api', taskId: 'docs' } }} />)
    expect(tabStops()).toEqual(['○ docs'])
    act(() => labelOf('notes').focus())
    expect(tabStops()).toEqual(['○ notes'])
  })

  it('moves between the rows with ↑ and ↓, Home and End, and between the filter and the first row', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    act(() => labelOf('Client').focus())
    await user.keyboard('{ArrowDown}')
    expect(labelOf('api')).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(labelOf('Archived')).toHaveFocus()
    await user.keyboard('{End}')
    expect(labelOf('notes')).toHaveFocus()
    await user.keyboard('{ArrowDown}') // the last row: stays
    expect(labelOf('notes')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(labelOf('Client')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('textbox', { name: 'Filter sidebar' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(labelOf('Client')).toHaveFocus()
    expect(tabStops()).toEqual(['Client'])
  })

  it('collapses and expands with ← and →, or goes to the row above in the tree and the first row inside', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    act(() => labelOf('docs').focus())
    await user.keyboard('{ArrowLeft}')
    expect(labelOf('api')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(labelOf('api')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '○ fix' })).not.toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(labelOf('Client')).toHaveFocus()
    await user.keyboard('{ArrowRight}') // already expanded: into it
    expect(labelOf('api')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(labelOf('api')).toHaveAttribute('aria-expanded', 'true')
    expect(labelOf('api')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(labelOf('fix')).toHaveFocus()
    await user.keyboard('{ArrowRight}') // a task: nothing inside
    expect(labelOf('fix')).toHaveFocus()

    // The Archived group opens and closes the same way, and its tasks lead back to it.
    act(() => labelOf('Archived').focus())
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(screen.getByRole('button', { name: 'old' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(labelOf('Archived')).toHaveFocus()
  })

  it("leaves the filter's ↓ and Esc to an input method while it composes", () => {
    const onFilterChange = vi.fn()
    const onMultiSelect = vi.fn()
    render(<Harness patch={{ onFilterChange, onMultiSelect, multiSelection: new Set(['fix', 'docs']) }} />)
    const box = screen.getByRole('textbox', { name: 'Filter sidebar' })
    act(() => box.focus())
    expect(fireEvent.keyDown(box, { key: 'ArrowDown', isComposing: true })).toBe(true)
    expect(fireEvent.keyDown(box, { key: 'Escape', isComposing: true })).toBe(true)
    expect(box).toHaveFocus()
    expect(onFilterChange).not.toHaveBeenCalled()
    expect(onMultiSelect).not.toHaveBeenCalled() // nor the sidebar's Esc, which clears the selection
  })

  it('leaves the arrows with modifiers to their own keys, and the row buttons alone', async () => {
    const onMultiSelect = vi.fn()
    render(<Harness patch={{ onMultiSelect }} />)
    act(() => labelOf('fix').focus())
    fireEvent.keyDown(labelOf('fix'), { key: 'ArrowDown', shiftKey: true }) // extends the selection
    expect(onMultiSelect).toHaveBeenCalled()
    fireEvent.keyDown(labelOf('docs'), { key: 'ArrowDown', ctrlKey: true })
    expect(labelOf('docs')).toHaveFocus()
    const rename = screen.getByRole('button', { name: 'Rename task docs' })
    act(() => rename.focus())
    fireEvent.keyDown(rename, { key: 'ArrowDown' })
    expect(rename).toHaveFocus()
  })
})

describe('Sidebar git badges', () => {
  it('shows ahead, behind and uncommitted badges with tooltips', () => {
    renderSidebar({ gitStatus: { fix: git({ ahead: 3, behind: 1, uncommitted: 2 }) } })
    expect(screen.getByTitle('3 commits ahead of origin/main')).toHaveTextContent('↑3')
    expect(screen.getByTitle('1 commit behind origin/main')).toHaveTextContent('↓1')
    expect(screen.getByTitle('2 uncommitted files')).toHaveTextContent('●2')
    expect(
      screen.getByRole('img', {
        name: '3 commits ahead of origin/main, 1 commit behind origin/main, 2 uncommitted files',
      }),
    ).toBeInTheDocument()
  })

  it('keeps the task button name free of the badges', () => {
    renderSidebar({ gitStatus: { fix: git({ ahead: 3 }) } })
    expect(screen.getByRole('button', { name: '○ fix' })).toBeInTheDocument()
  })

  it('shows only the non-zero counts, and nothing for a clean task or one without a status', () => {
    renderSidebar({ gitStatus: { fix: git({ uncommitted: 1 }), docs: git({}) } })
    expect(screen.getByTitle('1 uncommitted file')).toBeInTheDocument()
    expect(screen.queryByText(/↑|↓/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })
})

describe('Sidebar status dot', () => {
  /** The dot of a task or folder row: its button is named "<dot> <name>". */
  const dotOf = (name: string): HTMLElement => {
    const dot = screen.getByRole('button', { name: new RegExp(`^\\S ${name}$`, 'u') }).querySelector('.dot')
    if (!(dot instanceof HTMLElement)) throw new Error('no dot')
    return dot
  }

  it('shows Claude busy, waiting and idle, and a session without its claude window', () => {
    renderSidebar({
      state: appState(
        theme('Client', [repo('api', [task('fix'), task('docs'), task('ship'), task('shell')]), folder('notes')]),
      ),
      status: {
        running: ['fix', 'docs', 'ship', 'shell'],
        missing: [],
        activity: { fix: 'busy', docs: 'waiting', ship: 'idle' },
      },
    })
    expect(dotOf('fix')).toHaveClass('dot', 'running', 'busy')
    expect(dotOf('fix')).toHaveAttribute('title', 'Claude is working')
    expect(dotOf('docs')).toHaveClass('running', 'waiting')
    expect(dotOf('docs').title).toMatch(/^Waiting for you/)
    expect(dotOf('ship')).toHaveClass('running', 'idle')
    expect(dotOf('ship')).toHaveAttribute('title', 'Claude is idle')
    expect(dotOf('shell').className).toBe('dot running')
    expect(dotOf('fix')).toHaveTextContent('✻') // Claude Code's working mark
    for (const name of ['docs', 'ship', 'shell']) expect(dotOf(name)).toHaveTextContent('●')
  })

  it('keeps ○ for no session and ⚠ for a missing path', () => {
    renderSidebar({ status: { running: ['docs'], missing: ['docs', 'notes'], activity: { docs: 'busy' } } })
    expect(dotOf('fix').className).toBe('dot none')
    expect(dotOf('fix')).toHaveTextContent('○')
    expect(dotOf('docs').className).toBe('dot missing')
    expect(dotOf('docs')).toHaveTextContent('⚠')
    expect(dotOf('notes')).toHaveAttribute('title', 'Path missing')
  })
})

describe('Sidebar theme style', () => {
  it("shows the theme's icon before its name and a colour stripe, keeping the row's name", () => {
    renderSidebar({ state: appState({ ...theme('Client', []), color: 'purple', icon: '🚀' }, theme('Plain', [])) })
    const label = screen.getByRole('button', { name: 'Client' })
    expect(label).toHaveTextContent('🚀Client')
    const row = label.closest('.theme-row') as HTMLElement
    expect(row).toHaveClass('has-color')
    expect(row.style.getPropertyValue('--theme-color')).toBe('#a371f7')
    const plain = screen.getByRole('button', { name: 'Plain' }).closest('.theme-row') as HTMLElement
    expect(plain).not.toHaveClass('has-color')
    expect(plain.style.getPropertyValue('--theme-color')).toBe('')
  })

  it('ignores a colour that is not in the palette', () => {
    const odd = { ...theme('Odd', []), color: 'url(x)' as never }
    renderSidebar({ state: appState(odd) })
    const row = screen.getByRole('button', { name: 'Odd' }).closest('.theme-row') as HTMLElement
    expect(row.getAttribute('style')).toBeNull()
  })

  it('opens Customize theme from the row', async () => {
    const onCustomizeTheme = vi.fn()
    renderSidebar({ onCustomizeTheme })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Customize theme Client' }))
    expect(onCustomizeTheme).toHaveBeenCalledWith('Client')
  })
})

describe('Sidebar archived tasks', () => {
  const old = { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z' }
  const older = { ...task('older'), archivedAt: '2026-01-15T10:00:00.000Z' }
  const withArchived = appState(theme('Client', [repo('api', [task('fix'), old, older]), repo('web', [task('ui')])]))
  const user = (): ReturnType<typeof userEvent.setup> => userEvent.setup()

  it('archives an active task from its row', async () => {
    const onArchiveTask = vi.fn()
    renderSidebar({ onArchiveTask })
    await user().click(screen.getByRole('button', { name: 'Archive task fix' }))
    expect(onArchiveTask).toHaveBeenCalledWith('Client', 'api', 'fix', 'fix')
  })

  it('keeps archived tasks out of the task list, in a collapsed "Archived (N)" group', async () => {
    const onToggleArchived = vi.fn()
    renderSidebar({ state: withArchived, onToggleArchived })
    expect(screen.getByRole('button', { name: '○ fix' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /\bold/ })).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Archived (2)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByRole('button', { name: /Archived/ })).toHaveLength(1) // none for "web"
    await user().click(toggle)
    expect(onToggleArchived).toHaveBeenCalledWith('api')
  })

  it('lists them when expanded, with Restore and Delete, and selects one on click', async () => {
    const onSelect = vi.fn()
    const onRestoreTask = vi.fn()
    const onDeleteArchivedTask = vi.fn()
    renderSidebar({
      state: withArchived,
      archivedOpen: new Set(['api']),
      onSelect,
      onRestoreTask,
      onDeleteArchivedTask,
    })
    expect(screen.getByRole('button', { name: 'Archived (2)' })).toHaveAttribute('aria-expanded', 'true')
    const u = user()
    await u.click(screen.getByRole('button', { name: 'old' }))
    expect(onSelect).toHaveBeenCalledWith({ themeId: 'Client', itemId: 'api', taskId: 'old' })
    await u.click(screen.getByRole('button', { name: 'Restore task older' }))
    expect(onRestoreTask).toHaveBeenCalledWith('Client', 'api', 'older', 'older')
    await u.click(screen.getByRole('button', { name: 'Delete archived task old' }))
    expect(onDeleteArchivedTask).toHaveBeenCalledWith('Client', 'api', 'old', 'old')
    expect(screen.queryByRole('button', { name: 'Archive task old' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename task old' })).not.toBeInTheDocument()
  })

  it('marks the selected archived task', () => {
    renderSidebar({
      state: withArchived,
      archivedOpen: new Set(['api']),
      selected: { themeId: 'Client', itemId: 'api', taskId: 'old' },
    })
    expect(screen.getByRole('button', { name: 'old' }).closest('.row')).toHaveClass('selected')
  })

  it('shows matching archived tasks while filtering, with their group expanded', () => {
    renderSidebar({ state: withArchived, filter: 'older' })
    expect(screen.getByRole('button', { name: 'Archived (1)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'older' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'old' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '○ fix' })).not.toBeInTheDocument()
  })
})

describe('Sidebar run commands', () => {
  it("opens a repo's or folder's run command from its row, showing the command in the tooltip", async () => {
    const user = userEvent.setup()
    const onEditRunCommand = vi.fn()
    const withCommand = appState(
      theme('Client', [{ ...repo('api', [task('fix')]), runCommand: 'npm run dev' }, folder('notes')]),
    )
    renderSidebar({ state: withCommand, onEditRunCommand })
    const repoButton = screen.getByRole('button', { name: 'Run command for api…' })
    expect(repoButton).toHaveAttribute('title', 'Edit the run command: npm run dev')
    const folderButton = screen.getByRole('button', { name: 'Run command for notes…' })
    expect(folderButton).toHaveAttribute('title', 'Set a run command…')
    await user.click(repoButton)
    await user.click(folderButton)
    expect(onEditRunCommand.mock.calls).toEqual([
      ['Client', 'api'],
      ['Client', 'notes'],
    ])
  })
})

describe('Sidebar reordering', () => {
  const twoThemes = appState(
    theme('Client', [repo('api', [task('fix'), task('docs'), task('ship')]), folder('notes')]),
    theme('Personal', [repo('web', [task('ui')]), folder('diary')]),
  )

  /** A stand-in for the browser's DataTransfer, which jsdom lacks. */
  const dataTransfer = (): Pick<DataTransfer, 'dropEffect' | 'effectAllowed' | 'setData' | 'getData'> => ({
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: vi.fn(),
    getData: vi.fn(() => ''),
  })

  /** The row of a task or folder (its button reads "<dot> <name>"), or of a theme or repo (by its name). */
  const rowOf = (name: string): HTMLElement => {
    const button = screen.getByRole('button', { name: new RegExp(`^(\\S )?${name}$`, 'u') })
    return button.closest('.row') as HTMLElement
  }
  const taskRow = rowOf
  const themeRow = (name: string): HTMLElement => screen.getByRole('button', { name }).closest('.row') as HTMLElement

  /** Every row block is 20px high, from y = 100: the top half is "before", the bottom half "after". */
  const placeRows = (): void => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-drop]'))
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 20 } as DOMRect)
  }

  /** Fires a drag event at `clientY` (jsdom's events have none); true when the default was not prevented. */
  const drag = (
    type: 'dragOver' | 'drop',
    el: HTMLElement,
    dt: ReturnType<typeof dataTransfer>,
    clientY: number,
  ): boolean => {
    const event = createEvent[type](el, { dataTransfer: dt })
    Object.defineProperty(event, 'clientY', { value: clientY })
    return fireEvent(el, event)
  }

  it('moves a task by dropping it on another task of its repo, with an indicator line while over it', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, onMove })
    placeRows()
    const dt = dataTransfer()
    expect(taskRow('fix')).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(taskRow('fix'), { dataTransfer: dt })
    expect(dt.effectAllowed).toBe('move')
    expect(taskRow('fix')).toHaveClass('dragging')

    expect(drag('dragOver', taskRow('ship'), dt, 115)).toBe(false) // allowed: the default is prevented
    expect(dt.dropEffect).toBe('move')
    expect(taskRow('ship')).toHaveClass('drop-after')
    drag('dragOver', taskRow('ship'), dt, 105)
    expect(taskRow('ship')).toHaveClass('drop-before')
    expect(taskRow('ship')).not.toHaveClass('drop-after')

    drag('drop', taskRow('ship'), dt, 115)
    expect(onMove).toHaveBeenCalledWith({ kind: 'task', themeId: 'Client', repoId: 'api', taskId: 'fix', toIndex: 2 })
    expect(document.querySelector('.drop-before, .drop-after, .dragging')).toBeNull()
  })

  it('shows no line, and moves nothing, where the drop would leave the row where it is', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, onMove })
    placeRows()
    const dt = dataTransfer()
    fireEvent.dragStart(taskRow('fix'), { dataTransfer: dt })
    drag('dragOver', taskRow('docs'), dt, 105) // just after itself
    expect(taskRow('docs')).not.toHaveClass('drop-before')
    drag('drop', taskRow('docs'), dt, 105)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('refuses a task over another repo, and an item over another theme, with the not-allowed cursor', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, onMove })
    placeRows()
    const dt = dataTransfer()
    fireEvent.dragStart(taskRow('fix'), { dataTransfer: dt })
    expect(drag('dragOver', taskRow('ui'), dt, 115)).toBe(true) // not prevented: no drop here
    expect(dt.dropEffect).toBe('none')
    expect(taskRow('ui')).not.toHaveClass('drop-after')
    expect(drag('dragOver', rowOf('api'), dt, 115)).toBe(true) // its own repo's row is no task either
    drag('drop', taskRow('ui'), dt, 115)
    fireEvent.dragEnd(taskRow('fix'), { dataTransfer: dt })

    const dt2 = dataTransfer()
    fireEvent.dragStart(rowOf('notes'), { dataTransfer: dt2 })
    expect(drag('dragOver', rowOf('diary'), dt2, 105)).toBe(true)
    expect(dt2.dropEffect).toBe('none')
    expect(drag('dragOver', rowOf('ui'), dt2, 105)).toBe(true) // inside another theme's repo
    drag('drop', rowOf('diary'), dt2, 105)
    expect(onMove).not.toHaveBeenCalled()

    fireEvent.dragStart(rowOf('notes'), { dataTransfer: dt2 })
    expect(drag('dragOver', taskRow('fix'), dt2, 105)).toBe(false) // over its theme's repo, tasks included
    expect(rowOf('api').parentElement).toHaveClass('drop-before')
    drag('drop', taskRow('fix'), dt2, 105)
    expect(onMove).toHaveBeenCalledWith({ kind: 'item', themeId: 'Client', itemId: 'notes', toIndex: 0 })
  })

  it('moves a theme by dropping it anywhere over another theme, its items included', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, onMove })
    placeRows()
    const dt = dataTransfer()
    fireEvent.dragStart(themeRow('Client'), { dataTransfer: dt })
    expect(drag('dragOver', taskRow('ui'), dt, 115)).toBe(false)
    expect(themeRow('Personal').parentElement).toHaveClass('drop-after')
    drag('drop', taskRow('ui'), dt, 115)
    expect(onMove).toHaveBeenCalledWith({ kind: 'theme', themeId: 'Client', toIndex: 1 })
  })

  it('ignores drags that did not start on one of its rows, like files from the desktop', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, onMove })
    placeRows()
    const dt = dataTransfer()
    expect(drag('dragOver', taskRow('ship'), dt, 115)).toBe(true)
    drag('drop', taskRow('ship'), dt, 115)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('turns dragging off while the filter is active, as only some rows show', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, filter: 'i', onMove })
    expect(taskRow('fix')).toHaveAttribute('draggable', 'false')
    expect(themeRow('Client')).toHaveAttribute('draggable', 'false')
    expect(rowOf('api')).toHaveAttribute('draggable', 'false')
  })

  it('refuses a drag that starts while filtering', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, filter: 'i', onMove })
    placeRows()
    const dt = dataTransfer()
    expect(fireEvent.dragStart(taskRow('fix'), { dataTransfer: dt })).toBe(false)
    expect(drag('dragOver', taskRow('ship'), dt, 115)).toBe(true)
    drag('drop', taskRow('ship'), dt, 115)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('moves the focused row with Alt+Shift+↑/↓, keeping the focus on it', () => {
    const onMove = vi.fn()
    const props = sidebarProps({ state: twoThemes, onMove })
    const { rerender } = render(<Sidebar {...props} />)
    const fix = screen.getByRole('button', { name: '○ fix' })
    fix.focus()
    fireEvent.keyDown(fix, { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith({
      kind: 'task',
      themeId: 'Client',
      repoId: 'api',
      taskId: 'fix',
      toIndex: 1,
    })
    // As App shows the move: fix's row moves below docs.
    const moved = appState(
      theme('Client', [repo('api', [task('docs'), task('fix'), task('ship')]), folder('notes')]),
      twoThemes.themes[1],
    )
    fix.blur() // what Chromium does to a focused element the DOM moves; jsdom keeps the focus
    rerender(<Sidebar {...props} state={moved} />)
    expect(screen.getByRole('button', { name: '○ fix' })).toHaveFocus()

    fireEvent.keyDown(themeRow('Personal'), { key: 'ArrowUp', altKey: true, shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith({ kind: 'theme', themeId: 'Personal', toIndex: 0 })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Remove notes' }), {
      key: 'ArrowUp',
      altKey: true,
      shiftKey: true,
    })
    expect(onMove).toHaveBeenLastCalledWith({ kind: 'item', themeId: 'Client', itemId: 'notes', toIndex: 0 })
  })

  it('does nothing at either end of the list, nor without both Alt and Shift', () => {
    const onMove = vi.fn()
    renderSidebar({ state: twoThemes, onMove })
    fireEvent.keyDown(taskRow('fix'), { key: 'ArrowUp', altKey: true, shiftKey: true })
    fireEvent.keyDown(taskRow('ship'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    fireEvent.keyDown(taskRow('docs'), { key: 'ArrowDown', altKey: true })
    fireEvent.keyDown(taskRow('docs'), { key: 'ArrowDown', shiftKey: true })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('says to clear the filter instead of moving a row while filtering', () => {
    const onMove = vi.fn()
    const onAnnounce = vi.fn()
    renderSidebar({ state: twoThemes, filter: 'i', onMove, onAnnounce })
    fireEvent.keyDown(taskRow('fix'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(onMove).not.toHaveBeenCalled()
    expect(onAnnounce).toHaveBeenCalledWith('Clear the filter to move rows')
  })
})

describe('Sidebar budget badge', () => {
  it('marks a task over its budget, and only that one', () => {
    renderSidebar({ budgets: { fix: budgetStatus(5.2, 5)!, docs: budgetStatus(4.5, 5)! } })
    const badge = screen.getByRole('img', { name: 'Over budget: $5.20 of $5.00 task budget' })
    expect(badge).toHaveTextContent('$')
    expect(badge).toHaveAttribute('title', 'Over budget: $5.20 of $5.00 task budget')
    expect(screen.getAllByRole('img')).toHaveLength(1)
    // The task's button keeps its plain name.
    expect(screen.getByRole('button', { name: '○ fix' })).toBeInTheDocument()
  })

  it('shows nothing without budgets', () => {
    renderSidebar()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('Sidebar multi-selection', () => {
  const twoRepos = appState(
    theme('Client', [repo('api', [task('fix'), task('docs'), task('ship')]), folder('notes')]),
    theme('Personal', [repo('web', [task('ui'), { ...task('old'), archivedAt: '2026-02-01T10:00:00.000Z' }])]),
  )

  /** The Sidebar with App's part played: it keeps the multi-selection, and `selected` follows plain clicks. */
  function Harness(props: { patch?: Partial<SidebarProps>; initial?: string[] }): React.JSX.Element {
    const [multi, setMulti] = useState<ReadonlySet<string>>(new Set(props.initial))
    const [selected, setSelected] = useState(props.patch?.selected ?? null)
    return (
      <Sidebar
        {...sidebarProps({ state: twoRepos, archivedOpen: new Set(['web']), ...props.patch })}
        selected={selected}
        multiSelection={multi}
        onMultiSelect={(next) => {
          setMulti(next)
          props.patch?.onMultiSelect?.(next)
        }}
        onSelect={(t) => {
          setSelected(t)
          props.patch?.onSelect?.(t)
        }}
      />
    )
  }
  const fixTarget = { themeId: 'Client', itemId: 'api', taskId: 'fix' }
  const label = (name: string): HTMLElement =>
    screen.getByRole('button', { name: new RegExp(`^\\S ${name}(, selected)?$`, 'u') })
  const row = (name: string): HTMLElement => label(name).closest('.row') as HTMLElement
  /** The tasks in the multi-selection, as screen readers hear them: "● docs, selected". */
  const chosen = (): string[] =>
    screen
      .queryAllByRole('button', { name: /^\S .+, selected$/u })
      .map((b) => b.textContent?.replace(/^\S |, selected$/gu, '') ?? '')
  const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Selected tasks' })

  it('toggles tasks in with Ctrl+click, the current one included, without opening them', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Harness patch={{ selected: fixTarget, onSelect }} />)
    await user.keyboard('{Control>}')
    await user.click(label('docs'))
    expect(chosen()).toEqual(['fix', 'docs'])
    await user.click(label('ui')) // another repo: Ctrl+click spans repos
    expect(chosen()).toEqual(['fix', 'docs', 'ui'])
    await user.click(label('fix'))
    await user.keyboard('{/Control}')
    expect(chosen()).toEqual(['docs', 'ui'])
    expect(onSelect).not.toHaveBeenCalled()
    expect(label('ship')).toHaveAccessibleName('○ ship')
  })

  it('marks selected rows apart from the current task', () => {
    render(<Harness patch={{ selected: fixTarget }} initial={['docs', 'ship']} />)
    expect(row('fix')).toHaveClass('selected')
    expect(row('fix')).not.toHaveClass('multi-selected')
    expect(row('docs')).toHaveClass('multi-selected')
    expect(row('docs')).not.toHaveClass('selected')
    expect(label('docs')).toHaveAccessibleName('○ docs, selected')
    // aria-selected means nothing on an element without a role that takes it: screen readers never heard it.
    expect(document.querySelector('[aria-selected]')).toBeNull()
  })

  it("selects a range with Shift+click, within the clicked task's repo", async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Harness patch={{ onSelect }} />)
    await user.click(label('fix'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    await user.keyboard('{Shift>}')
    await user.click(label('ship'))
    expect(chosen()).toEqual(['fix', 'docs', 'ship'])
    await user.click(label('docs')) // from the same anchor: the range shrinks
    expect(chosen()).toEqual(['fix', 'docs'])
    await user.click(label('ui')) // the anchor is in another repo, above: from the top of web
    await user.keyboard('{/Shift}')
    expect(chosen()).toEqual(['ui'])
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('adds a range with Ctrl+Shift+click', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['ui']} />)
    await user.keyboard('{Control>}')
    await user.click(label('fix')) // the anchor
    await user.keyboard('{Shift>}')
    await user.click(label('docs'))
    await user.keyboard('{/Shift}{/Control}')
    expect(chosen()).toEqual(['fix', 'docs', 'ui'])
  })

  it('opens the task on a plain click, clearing the multi-selection', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Harness patch={{ onSelect }} initial={['docs', 'ship']} />)
    await user.click(label('ui'))
    expect(onSelect).toHaveBeenCalledWith({ themeId: 'Personal', itemId: 'web', taskId: 'ui' })
    expect(chosen()).toEqual([])
    expect(row('ui')).toHaveClass('selected')
  })

  it("clears the selection with Esc in the sidebar, while the filter's Esc only clears the filter", async () => {
    const onFilterChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness patch={{ onFilterChange, filter: 'i' }} initial={['fix', 'ui']} />)
    await user.click(screen.getByRole('textbox', { name: 'Filter sidebar' }))
    await user.keyboard('{Escape}')
    expect(onFilterChange).toHaveBeenCalledWith('')
    expect(chosen()).toEqual(['fix', 'ui'])
    label('fix').focus()
    await user.keyboard('{Escape}')
    expect(chosen()).toEqual([])
  })

  it('toggles the focused task with Space, and extends the selection with Shift+↑/↓, moving the focus', () => {
    const onSelect = vi.fn()
    render(<Harness patch={{ onSelect }} />)
    label('docs').focus()
    expect(fireEvent.keyDown(label('docs'), { key: ' ' })).toBe(false) // no click on the button
    expect(chosen()).toEqual(['docs'])
    fireEvent.keyDown(label('docs'), { key: 'ArrowDown', shiftKey: true })
    expect(chosen()).toEqual(['docs', 'ship'])
    expect(label('ship')).toHaveFocus()
    fireEvent.keyDown(label('ship'), { key: 'ArrowDown', shiftKey: true }) // the end of the repo
    expect(label('ship')).toHaveFocus()
    fireEvent.keyDown(label('ship'), { key: 'ArrowUp', shiftKey: true })
    fireEvent.keyDown(label('docs'), { key: 'ArrowUp', shiftKey: true })
    expect(chosen()).toEqual(['fix', 'docs'])
    expect(label('fix')).toHaveFocus()
    fireEvent.keyDown(label('fix'), { key: ' ' })
    expect(chosen()).toEqual(['docs'])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('says how many tasks are selected', async () => {
    const onAnnounce = vi.fn()
    const user = userEvent.setup()
    render(<Harness patch={{ onAnnounce }} initial={['fix']} />)
    await user.keyboard('{Control>}')
    await user.click(label('docs'))
    await user.keyboard('{/Control}')
    expect(onAnnounce).toHaveBeenLastCalledWith('2 tasks selected')
  })

  it('leaves archived tasks out, saying so', async () => {
    const onAnnounce = vi.fn()
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Harness patch={{ onAnnounce, onSelect }} initial={['fix', 'docs']} />)
    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('button', { name: 'old' }))
    await user.keyboard('{/Control}')
    expect(chosen()).toEqual(['fix', 'docs'])
    expect(onSelect).not.toHaveBeenCalled()
    expect(onAnnounce).toHaveBeenCalledWith('Archived tasks can’t be selected')
  })

  it('never starts a drag from a Ctrl- or Shift-click', () => {
    render(<Harness />)
    const dt = { dropEffect: 'none', effectAllowed: 'all', setData: vi.fn(), getData: vi.fn(() => '') }
    /** jsdom has no DragEvent: the modifier is set on the event by hand, as clientY is for reordering. */
    const dragStart = (modifier: 'ctrlKey' | 'shiftKey'): boolean => {
      const event = createEvent.dragStart(row('fix'), { dataTransfer: dt })
      Object.defineProperty(event, modifier, { value: true })
      return fireEvent(row('fix'), event)
    }
    expect(dragStart('ctrlKey')).toBe(false)
    expect(dragStart('shiftKey')).toBe(false)
    expect(row('fix')).not.toHaveClass('dragging')
    expect(dt.setData).not.toHaveBeenCalled()
  })

  it('still drags and moves with Alt+Shift+↑/↓ while tasks are selected', () => {
    const onMove = vi.fn()
    render(<Harness patch={{ onMove }} initial={['fix', 'docs']} />)
    fireEvent.keyDown(label('fix'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith({
      kind: 'task',
      themeId: 'Client',
      repoId: 'api',
      taskId: 'fix',
      toIndex: 1,
    })
    expect(chosen()).toEqual(['fix', 'docs'])
    const dt = { dropEffect: 'none', effectAllowed: 'all', setData: vi.fn(), getData: vi.fn(() => '') }
    for (const el of document.querySelectorAll<HTMLElement>('[data-drop]'))
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 20 } as DOMRect)
    fireEvent.dragStart(row('ship'), { dataTransfer: dt })
    const drop = createEvent.drop(row('fix'), { dataTransfer: dt })
    Object.defineProperty(drop, 'clientY', { value: 105 })
    fireEvent(row('fix'), drop)
    expect(onMove).toHaveBeenLastCalledWith({
      kind: 'task',
      themeId: 'Client',
      repoId: 'api',
      taskId: 'ship',
      toIndex: 0,
    })
  })

  describe('bulk bar', () => {
    it('shows from two selected tasks, with the bulk actions', async () => {
      const onBulkAction = vi.fn()
      const user = userEvent.setup()
      const { rerender } = render(<Sidebar {...sidebarProps({ state: twoRepos, multiSelection: new Set(['fix']) })} />)
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
      rerender(<Sidebar {...sidebarProps({ state: twoRepos, multiSelection: new Set(['fix', 'ui']), onBulkAction })} />)
      expect(bar()).toHaveTextContent('2 tasks selected')
      const buttons = within(bar()).getAllByRole('button')
      expect(buttons.map((b) => b.textContent)).toEqual(['Push…', 'Update…', 'Archive…', 'Remove…', 'Clear'])
      for (const name of [
        'Push the selected tasks…',
        'Update the selected tasks from base…',
        'Archive the selected tasks…',
        'Remove the selected tasks…',
      ])
        await user.click(within(bar()).getByRole('button', { name }))
      expect(onBulkAction.mock.calls.map((c) => c[0])).toEqual(['push', 'update', 'archive', 'remove'])
    })

    it('clears the selection', async () => {
      const user = userEvent.setup()
      render(<Harness initial={['fix', 'ui']} />)
      await user.click(within(bar()).getByRole('button', { name: 'Clear the selection' }))
      expect(chosen()).toEqual([])
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })

    it('shows what runs, with its actions off meanwhile', () => {
      renderSidebar({ state: twoRepos, multiSelection: new Set(['fix', 'ui']), bulkBusy: 'Pushing 2 tasks…' })
      expect(bar()).toHaveTextContent('Pushing 2 tasks…')
      for (const b of within(bar()).getAllByRole('button')) expect(b).toBeDisabled()
    })

    it('stays while a batch runs, as the tasks it removes leave the selection', () => {
      renderSidebar({ state: twoRepos, multiSelection: new Set(), bulkBusy: 'Removing 2 tasks…' })
      expect(bar()).toHaveTextContent('Removing 2 tasks…')
    })

    it('counts only active tasks', () => {
      act(() => {
        renderSidebar({ state: twoRepos, multiSelection: new Set(['fix', 'old', 'gone']) })
      })
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })
  })
})
