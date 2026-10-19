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
  /** The dot of a task or folder row: its button is named "<dot> [📁 ]<name>". */
  const dotOf = (name: string): HTMLElement => {
    const dot = screen.getByRole('button', { name: new RegExp(`^\\S (📁 )?${name}$`, 'u') }).querySelector('.dot')
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
    for (const name of ['fix', 'docs', 'ship', 'shell']) expect(dotOf(name)).toHaveTextContent('●')
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
    const label = screen.getByRole('button', { name: '▼ Client' })
    expect(label).toHaveTextContent('▼ 🚀Client')
    const row = label.closest('.theme-row') as HTMLElement
    expect(row).toHaveClass('has-color')
    expect(row.style.getPropertyValue('--theme-color')).toBe('#a371f7')
    const plain = screen.getByRole('button', { name: '▼ Plain' }).closest('.theme-row') as HTMLElement
    expect(plain).not.toHaveClass('has-color')
    expect(plain.style.getPropertyValue('--theme-color')).toBe('')
  })

  it('ignores a colour that is not in the palette', () => {
    const odd = { ...theme('Odd', []), color: 'url(x)' as never }
    renderSidebar({ state: appState(odd) })
    const row = screen.getByRole('button', { name: '▼ Odd' }).closest('.theme-row') as HTMLElement
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
    const toggle = screen.getByRole('button', { name: '▶ Archived (2)' })
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
    expect(screen.getByRole('button', { name: '▼ Archived (2)' })).toHaveAttribute('aria-expanded', 'true')
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
    expect(screen.getByRole('button', { name: '▼ Archived (1)' })).toBeInTheDocument()
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

  /** The row of a task or folder (its button reads "<dot> [📁 ]<name>"), or of a theme or repo (by its name). */
  const rowOf = (name: string): HTMLElement => {
    const button = screen.getByRole('button', { name: new RegExp(`^\\S (📁 |📦 )?${name}$`, 'u') })
    return button.closest('.row') as HTMLElement
  }
  const taskRow = rowOf
  const themeRow = (name: string): HTMLElement =>
    screen.getByRole('button', { name: `▼ ${name}` }).closest('.row') as HTMLElement

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
  const label = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^\\S ${name}$`, 'u') })
  const row = (name: string): HTMLElement => label(name).closest('.row') as HTMLElement
  /** The tasks in the multi-selection, by their rows' aria-selected. */
  const chosen = (): string[] =>
    [...document.querySelectorAll('.task-row[aria-selected="true"]')].map(
      (r) => r.querySelector('.row-label')?.textContent?.replace(/^\S /u, '') ?? '',
    )
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
    expect(row('ship')).toHaveAttribute('aria-selected', 'false')
  })

  it('marks selected rows apart from the current task', () => {
    render(<Harness patch={{ selected: fixTarget }} initial={['docs', 'ship']} />)
    expect(row('fix')).toHaveClass('selected')
    expect(row('fix')).not.toHaveClass('multi-selected')
    expect(row('docs')).toHaveClass('multi-selected')
    expect(row('docs')).not.toHaveClass('selected')
    expect(row('docs')).toHaveAttribute('aria-selected', 'true')
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
