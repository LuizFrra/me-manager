import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MAX_CLAUDE_MESSAGE } from '../../../../shared/types'
import type { ReviewComment } from '../../lib/review'
import { ReviewTray, type ReviewTrayProps } from './ReviewTray'

const COMMENTS: ReviewComment[] = [
  { id: 1, tab: 'changes', path: 'src/app.ts', lines: { start: 12, end: 15 }, note: 'Use a map here.' },
  { id: 2, tab: 'files', path: 'README.md', lines: { start: 3, end: 3 }, note: 'Typo' },
  { id: 3, tab: 'changes', path: 'old.ts', removed: { start: 7, end: 7 }, note: 'Keep this' },
]

function renderTray(over: Partial<ReviewTrayProps> = {}): ReviewTrayProps {
  const props: ReviewTrayProps = {
    comments: COMMENTS,
    sending: false,
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSend: vi.fn(),
    onCopy: vi.fn(),
    ...over,
  }
  render(<ReviewTray {...props} />)
  return props
}

describe('ReviewTray', () => {
  it('lists the comments with their locations and notes, and collapses', async () => {
    const user = userEvent.setup()
    renderTray()
    const tray = screen.getByRole('region', { name: 'Review comments' })
    const items = within(tray).getAllByRole('listitem')
    expect(
      items.map((li) => [li.querySelector('.review-location')?.textContent, li.querySelector('p')?.textContent]),
    ).toEqual([
      ['src/app.ts:12-15', 'Use a map here.'],
      ['README.md:3', 'Typo'],
      ['old.ts (removed line 7)', 'Keep this'],
    ])
    const toggle = screen.getByRole('button', { name: 'Review 3' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('opens, edits and deletes a comment, sends or copies them all', async () => {
    const user = userEvent.setup()
    const props = renderTray()
    await user.click(screen.getByRole('button', { name: 'README.md:3' }))
    expect(props.onOpen).toHaveBeenCalledWith(COMMENTS[1])
    await user.click(screen.getByRole('button', { name: 'Edit the comment on README.md:3' }))
    expect(props.onEdit).toHaveBeenCalledWith(COMMENTS[1])
    await user.click(screen.getByRole('button', { name: 'Delete the comment on old.ts (removed line 7)' }))
    expect(props.onDelete).toHaveBeenCalledWith(COMMENTS[2])
    await user.click(screen.getByRole('button', { name: 'Send to Claude' }))
    expect(props.onSend).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(props.onCopy).toHaveBeenCalled()
  })

  it('moves focus to the next comment when one is deleted, or to the toggle after the last', async () => {
    const user = userEvent.setup()
    function Harness(): React.JSX.Element {
      const [comments, setComments] = useState(COMMENTS)
      return (
        <ReviewTray
          comments={comments}
          sending={false}
          onOpen={() => {}}
          onEdit={() => {}}
          onDelete={(c) => setComments((cs) => cs.filter((x) => x.id !== c.id))}
          onSend={() => {}}
          onCopy={() => {}}
        />
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Delete the comment on src/app.ts:12-15' }))
    expect(screen.getByRole('button', { name: 'Delete the comment on README.md:3' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Delete the comment on old.ts (removed line 7)' }))
    expect(screen.getByRole('button', { name: 'Delete the comment on README.md:3' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Review 0' })).toHaveFocus()
  })

  it('shows that the review is being sent', () => {
    renderTray({ sending: true })
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  })

  it('says when the review is too long to send, and still copies it', () => {
    const long = [{ ...COMMENTS[0], note: 'x'.repeat(MAX_CLAUDE_MESSAGE) }]
    renderTray({ comments: long })
    expect(screen.getByRole('button', { name: 'Send to Claude' })).toBeDisabled()
    expect(screen.getByText(/too long to send/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled()
  })
})
