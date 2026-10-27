import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ChangedFile } from '../../../../shared/types'
import { ROW_HEIGHT } from '../../lib/useVirtualRows'
import { ChangesList } from './ChangesList'

const change = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'M',
  added: 3,
  removed: 1,
  binary: false,
  ...over,
})
const MANY = Array.from({ length: 2000 }, (_, i) => change(`src/mod${i % 10}/file${i}.ts`))
const list = (): HTMLElement => screen.getByRole('group', { name: 'Changed files' })
const rowCount = (): number => list().querySelectorAll('.change-row').length

describe('ChangesList', () => {
  it('says when there are no changes', () => {
    render(<ChangesList changes={[]} onSelect={vi.fn()} />)
    expect(screen.getByText('No changes yet.')).toBeInTheDocument()
  })

  it('names each status in words for screen readers, not by its letter', () => {
    render(<ChangesList changes={[change('src/a.ts'), change('n.ts', { status: 'U' })]} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'src/a.ts, modified, +3 −1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'n.ts, untracked, +3 −1' })).toBeInTheDocument()
  })

  it('lists a few changes in full, with status, rename and stats, and selects one', async () => {
    const onSelect = vi.fn()
    render(
      <ChangesList
        changes={[
          change('src/a.ts'),
          change('b.ts', { status: 'R', oldPath: 'old/b.ts' }),
          change('i.png', { binary: true }),
        ]}
        selected="b.ts"
        onSelect={onSelect}
      />,
    )
    expect(rowCount()).toBe(3)
    expect(screen.getByTitle('Renamed: old/b.ts → b.ts')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTitle('Modified: i.png')).toHaveTextContent('binary')
    expect(screen.getByTitle('Modified: src/a.ts')).toHaveTextContent('+3 −1')
    await userEvent.setup().click(screen.getByTitle('Modified: src/a.ts'))
    expect(onSelect).toHaveBeenCalledWith('src/a.ts')
  })

  it('renders only the rows in view of a long list, following the scroll position', () => {
    render(<ChangesList changes={MANY} onSelect={vi.fn()} />)
    expect(rowCount()).toBeLessThan(100)
    expect(screen.getByTitle('Modified: src/mod0/file0.ts')).toBeInTheDocument()
    list().scrollTop = 1500 * ROW_HEIGHT
    act(() => {
      list().dispatchEvent(new Event('scroll'))
    })
    expect(screen.queryByTitle('Modified: src/mod0/file0.ts')).not.toBeInTheDocument()
    expect(screen.getByTitle('Modified: src/mod0/file1500.ts').style.top).toBe(`${1500 * ROW_HEIGHT}px`)
    expect(rowCount()).toBeLessThan(100)
  })

  it('scrolls the selected change into view and moves between rows with the arrow keys', async () => {
    const user = userEvent.setup()
    render(<ChangesList changes={MANY} selected="src/mod7/file1777.ts" onSelect={vi.fn()} />)
    const row = screen.getByTitle('Modified: src/mod7/file1777.ts')
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(list().scrollTop).toBeGreaterThan(1700 * ROW_HEIGHT)
    row.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTitle('Modified: src/mod8/file1778.ts')).toHaveFocus()
    await user.keyboard('{PageUp}{Home}')
    expect(screen.getByTitle('Modified: src/mod0/file0.ts')).toHaveFocus()
  })
})
