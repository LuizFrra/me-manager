import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { LiveStatus, TaskGitStatus } from '../../../shared/types'
import { appState, repo, task, theme } from '../test/fixtures'
import { Sidebar, type SidebarProps } from './Sidebar'

// Counts the task rows' renders.
const rows = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./SidebarTaskRow', async (importOriginal) => {
  const real = await importOriginal<typeof import('./SidebarTaskRow')>()
  return {
    ...real,
    TaskRow: (props: Parameters<typeof real.TaskRow>[0]) => {
      rows.renders++
      return real.TaskRow(props)
    },
  }
})

const ids = Array.from({ length: 20 }, (_, i) => `t${i}`)
const state = appState(
  theme('Client', [
    repo(
      'api',
      ids.map((id) => task(id)),
    ),
  ]),
)
const git = (ahead: number): TaskGitStatus => ({ ahead, behind: 0, uncommitted: 0, branch: 'b' })

/** Every prop, with new callbacks (as App's inline arrows are at each render), and `patch` on top. */
function props(patch: Partial<SidebarProps> = {}): SidebarProps {
  const noop = (): void => {}
  return {
    state,
    status: { running: ids, missing: [], activity: Object.fromEntries(ids.map((id) => [id, 'idle'])) },
    gitStatus: Object.fromEntries(ids.map((id) => [id, git(0)])),
    selected: { themeId: 'Client', itemId: 'api', taskId: 't0' },
    collapsed: new Set(),
    onToggleCollapsed: noop,
    filter: '',
    onFilterChange: noop,
    onSelect: noop,
    onAddTheme: noop,
    onRenameTheme: noop,
    onCustomizeTheme: noop,
    onRemoveTheme: noop,
    onAddRepo: noop,
    onCloneRepo: noop,
    onAddFolder: noop,
    onRemoveItem: noop,
    onAddTask: noop,
    onRenameTask: () => {},
    onRemoveTask: () => {},
    onArchiveTask: () => {},
    onToggleArchived: noop,
    onRestoreTask: noop,
    onDeleteArchivedTask: noop,
    onEditRunCommand: noop,
    onMove: noop,
    multiSelection: new Set(),
    onMultiSelect: noop,
    onBulkAction: noop,
    onAnnounce: noop,
    onOpenSettings: noop,
    onOpenUsage: noop,
    ...patch,
  }
}

it('re-renders only the task rows whose own data changed', () => {
  const first = props()
  const { rerender } = render(<Sidebar {...first} />)
  expect(rows.renders).toBe(ids.length)

  // A poll moved one task's git badge (the other entries keep their objects, as App's merge keeps them).
  let before = rows.renders
  const gitStatus = { ...first.gitStatus, t5: git(1) }
  rerender(<Sidebar {...props({ gitStatus })} />)
  expect(rows.renders - before).toBe(1)

  // One task started working.
  before = rows.renders
  const status: LiveStatus = { ...first.status, activity: { ...first.status.activity, t7: 'busy' } }
  rerender(<Sidebar {...props({ gitStatus, status })} />)
  expect(rows.renders - before).toBe(1)

  // Another task was opened: the one left and the one opened.
  before = rows.renders
  const selected = { themeId: 'Client', itemId: 'api', taskId: 't9' }
  rerender(<Sidebar {...props({ gitStatus, status, selected })} />)
  expect(rows.renders - before).toBe(2)
})
