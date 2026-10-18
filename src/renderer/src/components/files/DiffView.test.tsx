import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DiffView } from './DiffView'
import {
  ADDED_FILE,
  BINARY,
  MULTI_HUNK,
  NO_NEWLINE,
  RENAME_ONLY,
  SINGLE_HUNK,
  UNTRACKED_NO_INDEX,
} from '../../lib/diff/fixtures'

function largeDiff(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+added ${i + 1}`).join('\n')
  return `diff --git a/big.txt b/big.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/big.txt
@@ -0,0 +1,${lines} @@
${body}
`
}

describe('DiffView', () => {
  it('renders an added line with class diff-add and its line number', () => {
    render(<DiffView diff={SINGLE_HUNK} />)
    const row = screen.getByText('BETA').closest('tr')
    expect(row).toHaveClass('diff-add')
    const cells = row!.querySelectorAll('td')
    expect(cells[0]).toHaveTextContent('')
    expect(cells[1]).toHaveTextContent('2')
  })

  it('renders deletions, context and hunk headers with their classes', () => {
    render(<DiffView diff={SINGLE_HUNK} />)
    const del = screen.getByText('beta').closest('tr')!
    expect(del).toHaveClass('diff-del')
    expect(del.querySelectorAll('td')[0]).toHaveTextContent('2')
    expect(screen.getByText('alpha').closest('tr')).toHaveClass('diff-context')
    expect(screen.getByText('@@ -1,3 +1,3 @@').closest('tr')).toHaveClass('diff-hunk')
  })

  it('renders "no newline" notes with class diff-note', () => {
    render(<DiffView diff={NO_NEWLINE} />)
    const notes = screen.getAllByText('\\ No newline at end of file')
    expect(notes).toHaveLength(2)
    for (const n of notes) expect(n.closest('tr')).toHaveClass('diff-note')
  })

  it('shows "No changes." for empty input', () => {
    render(<DiffView diff="" />)
    expect(screen.getByText('No changes.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows a notice for binary files', () => {
    render(<DiffView diff={BINARY} />)
    expect(screen.getByText('Binary file changed.')).toBeInTheDocument()
  })

  it('shows the old path for a pure rename', () => {
    render(<DiffView diff={RENAME_ONLY} />)
    expect(screen.getByText('Renamed from old-name.txt')).toBeInTheDocument()
  })

  it('hides a large diff behind a button and renders it on click', async () => {
    const user = userEvent.setup()
    render(<DiffView diff={largeDiff(5001)} />)
    expect(screen.getByText('Large diff (5001 lines)')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('added 5001').closest('tr')).toHaveClass('diff-add')
  })

  it('renders a 5000-line diff directly', () => {
    render(<DiffView diff={largeDiff(5000)} />)
    expect(screen.queryByRole('button', { name: 'Show diff anyway' })).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('collapses again when a different large diff arrives', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DiffView diff={largeDiff(5001)} />)
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    rerender(<DiffView diff={largeDiff(6000)} />)
    expect(screen.getByText('Large diff (6000 lines)')).toBeInTheDocument()
  })

  it('renders <script> in diff text as plain text', () => {
    const { container } = render(<DiffView diff={UNTRACKED_NO_INDEX} />)
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})

describe('DiffView split layout', () => {
  /** A row's cells as text, `·` for an empty one. */
  const cells = (row: Element): string[] => [...row.querySelectorAll('td')].map((td) => td.textContent || '·')

  it('shows old on the left and new on the right, with line numbers on both sides', () => {
    render(<DiffView diff={SINGLE_HUNK} layout="split" />)
    const table = screen.getByRole('table', { name: 'Side-by-side diff' })
    const rows = [...table.querySelectorAll('tr')]
    expect(rows.map(cells)).toEqual([
      ['@@ -1,3 +1,3 @@'],
      ['1', 'alpha', '1', 'alpha'],
      ['2', 'beta', '2', 'BETA'],
      ['3', 'gamma', '3', 'gamma'],
    ])
    expect(screen.getByText('beta')).toHaveClass('diff-text', 'diff-del')
    expect(screen.getByText('BETA')).toHaveClass('diff-text', 'diff-add')
    expect(screen.getAllByText('alpha').map((td) => td.className)).toEqual([
      'diff-text diff-context',
      'diff-text diff-context',
    ])
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toHaveAttribute('colspan', '4')
  })

  it('pads the side without a line with empty cells', () => {
    const { container } = render(<DiffView diff={ADDED_FILE} layout="split" />)
    const row = screen.getByText('brand new').closest('tr')!
    expect(cells(row)).toEqual(['·', '·', '1', 'brand new'])
    expect(row.querySelectorAll('td.diff-empty')).toHaveLength(2)
    expect(container.querySelector('.diff-view')).toHaveClass('diff-view-split')
  })

  it('puts the no-newline notes on their sides', () => {
    render(<DiffView diff={NO_NEWLINE} layout="split" />)
    const notes = screen.getAllByText('\\ No newline at end of file')
    expect(notes).toHaveLength(2)
    for (const n of notes) expect(n).toHaveClass('diff-note')
    expect(cells(notes[0].closest('tr')!)).toEqual([
      '·',
      '\\ No newline at end of file',
      '·',
      '\\ No newline at end of file',
    ])
  })

  it('renders every hunk with its header', () => {
    render(<DiffView diff={MULTI_HUNK} layout="split" />)
    expect(screen.getByText('@@ -24,7 +24,7 @@ line 23')).toBeInTheDocument()
    expect(cells(screen.getByText('line twenty-seven').closest('tr')!)).toEqual([
      '27',
      'line 27',
      '27',
      'line twenty-seven',
    ])
  })

  it('collapses a large diff the same way, then renders it split', async () => {
    const user = userEvent.setup()
    render(<DiffView diff={largeDiff(5001)} layout="split" />)
    expect(screen.getByText('Large diff (5001 lines)')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    expect(screen.getByRole('table', { name: 'Side-by-side diff' })).toBeInTheDocument()
    expect(screen.getByText('added 5001')).toHaveClass('diff-add')
  })

  it('switches layouts without losing the expanded state of a large diff', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DiffView diff={largeDiff(5001)} />)
    await user.click(screen.getByRole('button', { name: 'Show diff anyway' }))
    rerender(<DiffView diff={largeDiff(5001)} layout="split" />)
    expect(screen.getByRole('table', { name: 'Side-by-side diff' })).toBeInTheDocument()
  })

  it('renders <script> in diff text as plain text', () => {
    const { container } = render(<DiffView diff={UNTRACKED_NO_INDEX} layout="split" />)
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})
