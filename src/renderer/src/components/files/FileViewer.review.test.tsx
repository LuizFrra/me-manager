import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FileContent, Target } from '../../../../shared/types'
import { SINGLE_HUNK } from '../../lib/diff/fixtures'
import { FileViewer, type FileViewerProps } from './FileViewer'

// Not mocked here (unlike FileViewer.test.tsx): the selection comes from the real code and diff views.

const TARGET: Target = { themeId: 't', itemId: 'r', taskId: 'k' }
const text = (content: string): FileContent => ({ kind: 'text', content, size: content.length, truncated: false })
/** Line `n` of the code view's gutter (8px padding, 18px lines; jsdom has no layout). */
const lineY = (n: number): number => 8 + (n - 1) * 18 + 5

function renderViewer(over: Partial<FileViewerProps>): ReturnType<typeof render> {
  const props: FileViewerProps = {
    api: { readImage: async () => null, openExternal: async () => {} },
    target: TARGET,
    tab: 'files',
    mdMode: 'raw',
    canGoBack: false,
    onBack: () => {},
    onMdMode: () => {},
    onOpenLink: () => {},
    onOpenFile: () => {},
    onError: () => {},
    ...over,
  }
  return render(<FileViewer {...props} />)
}

describe('FileViewer review comments', () => {
  it('comments on the selected lines of a file, then clears the selection once the comment is saved', async () => {
    const user = userEvent.setup()
    const onComment = vi.fn()
    renderViewer({ path: 'src/app.ts', content: text('a\nb\nc\nd\n'), onComment })
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
    const gutter = screen.getByRole('group', { name: 'Line numbers' })
    fireEvent.click(gutter, { clientY: lineY(2) })
    fireEvent.click(gutter, { clientY: lineY(3), shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Lines 2–3 selected')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onComment).toHaveBeenCalledWith(
      { path: 'src/app.ts', tab: 'files', lines: { start: 2, end: 3 } },
      expect.any(Function),
    )
    // Focus is on the line numbers, for the dialog to give it back to.
    expect(gutter).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Lines 2–3 selected')
    const done = onComment.mock.calls[0][1] as () => void
    act(() => done())
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('comments with C from the line numbers, and clears the selection with its ✕', async () => {
    const user = userEvent.setup()
    const onComment = vi.fn()
    renderViewer({ path: 'a.ts', content: text('a\nb\n'), onComment })
    screen.getByRole('group', { name: 'Line numbers' }).focus()
    await user.keyboard('{ArrowDown}c')
    expect(onComment).toHaveBeenCalledWith(
      { path: 'a.ts', tab: 'files', lines: { start: 1, end: 1 } },
      expect.any(Function),
    )
    await user.click(screen.getByRole('button', { name: 'Clear the line selection' }))
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('comments on diff lines, deleted ones by their old number, in either layout', async () => {
    const user = userEvent.setup()
    const onComment = vi.fn()
    const { rerender } = renderViewer({ tab: 'changes', path: 'single.txt', diff: SINGLE_HUNK, onComment })
    const row = (t: string): HTMLElement[] => [
      ...screen.getByText(t).closest('tr')!.querySelectorAll<HTMLElement>('td'),
    ]
    fireEvent.click(row('beta')[0])
    fireEvent.click(row('BETA')[1], { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Line 2 and removed line 2 selected')
    const props = {
      api: { readImage: async () => null, openExternal: async () => {} },
      target: TARGET,
      tab: 'changes' as const,
      path: 'single.txt',
      diff: SINGLE_HUNK,
      mdMode: 'raw' as const,
      canGoBack: false,
      onBack: () => {},
      onMdMode: () => {},
      onOpenLink: () => {},
      onOpenFile: () => {},
      onError: () => {},
      onComment,
    }
    rerender(<FileViewer {...props} diffLayout="split" />)
    expect(screen.getByRole('status')).toHaveTextContent('Line 2 and removed line 2 selected')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onComment).toHaveBeenCalledWith(
      { path: 'single.txt', tab: 'changes', lines: { start: 2, end: 2 }, removed: { start: 2, end: 2 } },
      expect.any(Function),
    )
  })

  it('drops the selection for another file or a new version of the diff', () => {
    const onComment = vi.fn()
    const base = {
      api: { readImage: async () => null, openExternal: async () => {} },
      target: TARGET,
      mdMode: 'raw' as const,
      canGoBack: false,
      onBack: () => {},
      onMdMode: () => {},
      onOpenLink: () => {},
      onOpenFile: () => {},
      onError: () => {},
      onComment,
    }
    const content = text('a\nb\n')
    const { rerender } = render(<FileViewer {...base} tab="files" path="a.ts" content={content} />)
    fireEvent.click(screen.getByRole('group', { name: 'Line numbers' }), { clientY: lineY(1) })
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument()
    rerender(<FileViewer {...base} tab="files" path="b.ts" content={content} />)
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()

    rerender(<FileViewer {...base} tab="changes" path="single.txt" diff={SINGLE_HUNK} />)
    fireEvent.click(screen.getByText('alpha').closest('tr')!.querySelector('td')!)
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument()
    rerender(<FileViewer {...base} tab="changes" path="single.txt" diff={SINGLE_HUNK.replace('BETA', 'Beta')} />)
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('offers no line selection without onComment, or for rendered Markdown', () => {
    const { rerender } = renderViewer({ path: 'a.ts', content: text('a\n') })
    expect(screen.queryByRole('group', { name: 'Line numbers' })).toBeNull()
    rerender(
      <FileViewer
        api={{ readImage: async () => null, openExternal: async () => {} }}
        target={TARGET}
        tab="files"
        path="README.md"
        content={text('# Hi\n')}
        mdMode="view"
        canGoBack={false}
        onBack={() => {}}
        onMdMode={() => {}}
        onOpenLink={() => {}}
        onOpenFile={() => {}}
        onError={() => {}}
        onComment={() => {}}
      />,
    )
    expect(screen.queryByRole('group', { name: 'Line numbers' })).toBeNull()
  })
})
