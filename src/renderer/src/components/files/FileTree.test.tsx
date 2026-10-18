import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ChangeStatus } from '../../../../shared/types'
import { ancestorDirs, buildTree } from '../../lib/fileTree'
import { ROW_HEIGHT } from '../../lib/useVirtualRows'
import { FileTree } from './FileTree'

/** 5,000 files: 10 packages × 10 folders × 50 files, `pkg3/dir7/f3350.ts`. */
const PATHS = Array.from({ length: 5000 }, (_, i) => `pkg${Math.floor(i / 500)}/dir${Math.floor(i / 50) % 10}/f${i}.ts`)

/** A FileTree whose directories open and close, starting with the selected file's ancestors open (or all). */
function Tree(props: {
  paths?: string[]
  selected?: string
  allOpen?: boolean
  badges?: Map<string, ChangeStatus>
  onSelect?: (path: string) => void
}): React.JSX.Element {
  const [nodes] = useState(() => buildTree(props.paths ?? PATHS))
  const [open, setOpen] = useState(() => new Set(ancestorDirs(props.selected)))
  const isOpen = useCallback((dir: string) => props.allOpen === true || open.has(dir), [open, props.allOpen])
  return (
    <FileTree
      nodes={nodes}
      selected={props.selected}
      badges={props.badges ?? new Map()}
      isOpen={isOpen}
      onToggle={(dir) =>
        setOpen((prev) => {
          const next = new Set(prev)
          if (!next.delete(dir)) next.add(dir)
          return next
        })
      }
      onSelect={props.onSelect ?? (() => {})}
    />
  )
}

const scroller = (): HTMLElement => screen.getByRole('group', { name: 'Files' })
const rowCount = (): number => scroller().querySelectorAll('.tree-row').length

describe('FileTree', () => {
  it('renders a small tree in full, with expanded state, badges and the selection', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <Tree
        paths={['src/a.ts', 'src/b.ts', 'README.md']}
        badges={new Map([['src/a.ts', 'M' as const]])}
        onSelect={onSelect}
      />,
    )
    const src = screen.getByRole('button', { name: 'src' })
    expect(src).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTitle('Contains changes')).toBeInTheDocument()
    expect(rowCount()).toBe(2)
    await user.click(src)
    expect(src).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'a.ts, modified' })).toHaveStyle({ paddingLeft: '20px' })
    expect(screen.getByRole('button', { name: 'a.ts, modified' }).style.position).toBe('') // not virtual
    await user.click(screen.getByRole('button', { name: 'README.md' }))
    expect(onSelect).toHaveBeenCalledWith('README.md')
  })

  it('renders fewer than 100 rows of a fully expanded 5,000-file tree', () => {
    render(<Tree allOpen />)
    expect(rowCount()).toBeGreaterThan(10)
    expect(rowCount()).toBeLessThan(100)
    const inner = scroller().firstElementChild as HTMLElement
    expect(inner).toHaveClass('virtual-rows')
    // 5,000 files, 100 folders and 10 packages.
    expect(inner.style.height).toBe(`${5110 * ROW_HEIGHT}px`)
  })

  it('scrolls the selected file into view, at its row offset, and still finds it after scrolling away and back', () => {
    const selected = 'pkg7/dir4/f3725.ts'
    render(<Tree allOpen selected={selected} />)
    const row = screen.getByRole('button', { name: 'f3725.ts' })
    expect(row).toHaveAttribute('aria-current', 'true')
    // Rows before it: pkg0..pkg6 (7 × 511 rows), pkg7, dir0..dir3 (4 × 51), dir4, and f3700..f3724 (25).
    const index = 7 * 511 + 1 + 4 * 51 + 1 + 25
    expect(row.style.top).toBe(`${index * ROW_HEIGHT}px`)
    expect(scroller().scrollTop).toBeGreaterThan(0)
    expect(rowCount()).toBeLessThan(100)

    scroller().scrollTop = 0
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(screen.queryByRole('button', { name: 'f3725.ts' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pkg0' })).toBeInTheDocument()

    scroller().scrollTop = index * ROW_HEIGHT - 100
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('button', { name: 'f3725.ts' })).toHaveAttribute('aria-current', 'true')
  })

  it('opens the selected file’s folders in a collapsed tree and shows it', () => {
    render(<Tree selected="pkg9/dir9/f4999.ts" />)
    expect(screen.getByRole('button', { name: 'f4999.ts' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'pkg9' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves focus with the arrow keys, opening and closing folders, and keeps the focused row while scrolled away', async () => {
    const user = userEvent.setup()
    render(<Tree allOpen />)
    await user.click(screen.getByRole('button', { name: 'pkg0' })) // focuses it (allOpen ignores the toggle)
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'dir0' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'f0.ts' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('button', { name: 'dir0' })).toHaveFocus()

    await user.keyboard('{End}')
    expect(screen.getByRole('button', { name: 'f4999.ts' })).toHaveFocus()
    expect(rowCount()).toBeLessThan(100)
    // Scrolled back to the top by hand, the focused row is still there (and focused).
    scroller().scrollTop = 0
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('button', { name: 'pkg0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'f4999.ts' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('button', { name: 'pkg0' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'f4999.ts' })).not.toBeInTheDocument()
  })

  it('opens a closed folder with → and closes it with ←', async () => {
    const user = userEvent.setup()
    render(<Tree paths={['src/a.ts', 'src/b.ts']} />)
    const src = screen.getByRole('button', { name: 'src' })
    src.focus()
    await user.keyboard('{ArrowRight}')
    expect(src).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'a.ts' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(src).toHaveFocus()
    expect(src).toHaveAttribute('aria-expanded', 'false')
  })
})
