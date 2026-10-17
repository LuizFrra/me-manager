import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeManagerApi, Target } from '../../../../shared/types'
import { createMockApi } from '../../api/mockApi'
import { DEFAULT_PANEL, type PanelState } from '../../lib/panelState'
import { PANEL_POLL_MS, SidePanel } from './SidePanel'

vi.mock('./MarkdownView', () => ({
  MarkdownView: (p: { source: string; filePath: string; onOpenLink: (path: string) => void }) => (
    <div data-testid="markdown">
      MD:{p.source}
      <button onClick={() => p.onOpenLink('docs/guide.md')}>link from {p.filePath}</button>
    </div>
  ),
}))
vi.mock('./DiffView', () => ({ DiffView: (p: { diff: string }) => <pre data-testid="diff">DIFF:{p.diff}</pre> }))

const TASK: Target = { themeId: 't1', itemId: 'r1', taskId: 'k1' }
const FOLDER: Target = { themeId: 't1', itemId: 'f1' }

interface HarnessProps {
  api: MeManagerApi
  target?: Target
  isRepo?: boolean
  missing?: boolean
  initial?: Partial<PanelState>
  onError?: (e: unknown) => void
}

function Harness({
  api,
  target = TASK,
  isRepo = true,
  missing = false,
  initial,
  onError,
}: HarnessProps): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ ...DEFAULT_PANEL, ...initial })
  return (
    <SidePanel
      api={api}
      target={target}
      isRepo={isRepo}
      missing={missing}
      state={state}
      onState={setState}
      onError={onError ?? (() => {})}
      onClose={() => {}}
    />
  )
}

const fileButton = (name: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^${name}(, [a-z]+)?$`) })
const codeText = (): string => document.querySelector('.code-body')?.textContent ?? ''

describe('SidePanel', () => {
  afterEach(() => vi.useRealTimers())

  it('lists files as a tree with change badges, and expands directories', async () => {
    const user = userEvent.setup()
    render(<Harness api={createMockApi()} />)
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument()
    const src = screen.getByRole('button', { name: 'src' })
    expect(src).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /^app\.ts/ })).not.toBeInTheDocument()
    await user.click(src)
    expect(src).toHaveAttribute('aria-expanded', 'true')
    expect(fileButton('app\\.ts')).toHaveTextContent('M')
    expect(fileButton('notes\\.txt')).toHaveTextContent('U')
  })

  it('narrows the tree with the filter, showing matching directories expanded', async () => {
    const user = userEvent.setup()
    render(<Harness api={createMockApi()} />)
    await screen.findByRole('button', { name: 'README.md' })
    await user.type(screen.getByRole('textbox', { name: 'Filter files' }), 'FORMAT')
    expect(screen.queryByRole('button', { name: 'README.md' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'util' })).toHaveAttribute('aria-expanded', 'true')
    expect(fileButton('format\\.ts')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Filter files' }), 'zzz')
    expect(screen.getByText('No files match.')).toBeInTheDocument()
  })

  it('reads a clicked file and shows it with line numbers', async () => {
    const user = userEvent.setup()
    const api = createMockApi()
    const readFile = vi.spyOn(api, 'readFile')
    render(<Harness api={api} />)
    await user.click(await screen.findByRole('button', { name: 'package.json' }))
    expect(readFile).toHaveBeenCalledWith(TASK, 'package.json')
    await vi.waitFor(() => expect(codeText()).toContain('"demo-project"'))
    expect(screen.getByRole('button', { name: 'package.json' })).toHaveAttribute('aria-current', 'true')
    expect(document.querySelector('.code-gutter')?.textContent).toBe('1\n2\n3\n4\n5')
  })

  it('shows binary, missing and truncated files', async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      listFiles: async () => ['big.log', 'gone.ts', 'icon.png'],
      readFile: async (_t, path) =>
        path === 'icon.png'
          ? { kind: 'binary', size: 2048 }
          : path === 'big.log'
            ? { kind: 'text', content: 'start', size: 1_500_000, truncated: true }
            : { kind: 'missing' },
    })
    render(<Harness api={api} />)
    await user.click(await screen.findByRole('button', { name: 'icon.png' }))
    expect(await screen.findByText('Binary file (2.0 KB)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'gone.ts' }))
    expect(await screen.findByText('File no longer exists')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'big.log' }))
    expect(await screen.findByText(/Large file \(1\.4 MB\)/)).toBeInTheDocument()
    expect(codeText()).toBe('start')
  })

  it('renders Markdown, toggles Raw, follows links and goes back', async () => {
    const user = userEvent.setup()
    render(<Harness api={createMockApi()} />)
    await user.click(await screen.findByRole('button', { name: 'README.md' }))
    const md = await screen.findByTestId('markdown')
    expect(md).toHaveTextContent('MD:# Demo project')

    await user.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(codeText()).toContain('# Demo project')
    expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'View' }))

    expect(screen.queryByRole('button', { name: '← Back' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'link from README.md' }))
    expect(await screen.findByText(/MD:# Guide/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'guide.md' })).toHaveAttribute('aria-current', 'true')
    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(await screen.findByText(/MD:# Demo project/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← Back' })).not.toBeInTheDocument()
  })

  it('hides the Changes tab for folders and never asks for changes', async () => {
    const api = createMockApi()
    const listChanges = vi.spyOn(api, 'listChanges')
    render(<Harness api={api} target={FOLDER} isRepo={false} initial={{ tab: 'changes' }} />)
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Changes/ })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(listChanges).not.toHaveBeenCalled()
  })

  it('lists changes, shows a diff and opens the file', async () => {
    const user = userEvent.setup()
    const api = createMockApi()
    const fileDiff = vi.spyOn(api, 'fileDiff')
    render(<Harness api={api} />)
    await user.click(await screen.findByRole('tab', { name: 'Changes 4' }))
    const list = document.querySelector('.changes-list') as HTMLElement
    const row = within(list).getByRole('button', { name: /src\/app\.ts/ })
    expect(row).toHaveTextContent('+3 −1')
    await user.click(row)
    expect(fileDiff).toHaveBeenCalledWith(TASK, 'src/app.ts')
    expect(await screen.findByTestId('diff')).toHaveTextContent('DIFF:diff --git a/src/app.ts')

    await user.click(within(list).getByRole('button', { name: /src\/legacy\.ts/ }))
    expect(await screen.findByRole('button', { name: 'Open file' })).toBeDisabled()

    await user.click(within(list).getByRole('button', { name: /src\/app\.ts/ }))
    await user.click(screen.getByRole('button', { name: 'Open file' }))
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(fileButton('app\\.ts')).toHaveAttribute('aria-current', 'true')
    await vi.waitFor(() => expect(codeText()).toContain('greetAll'))
  })

  it('shows the empty and fallback states of Changes', async () => {
    const user = userEvent.setup()
    render(<Harness api={createMockApi({ listChanges: async () => ({ files: [], fallback: 'uncommitted-only' }) })} />)
    await user.click(await screen.findByRole('tab', { name: 'Changes 0' }))
    expect(screen.getByText('No changes yet.')).toBeInTheDocument()
    expect(screen.getByText('Base branch not found — showing uncommitted changes only.')).toBeInTheDocument()
  })

  it('shows a message instead of loading when the folder is missing', async () => {
    const api = createMockApi()
    const listFiles = vi.spyOn(api, 'listFiles')
    render(<Harness api={api} missing />)
    expect(screen.getByText("⚠ This task's folder is missing.")).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Filter files' })).not.toBeInTheDocument()
    expect(listFiles).not.toHaveBeenCalled()
  })

  it('reports errors from loading to onError', async () => {
    const onError = vi.fn()
    render(
      <Harness api={createMockApi({ listFiles: async () => Promise.reject(new Error('boom')) })} onError={onError} />,
    )
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error('boom')))
  })

  it('polls changes and the selected file every 3 s, silently marking failures, until unmounted', async () => {
    vi.useFakeTimers()
    let fail = false
    let content = 'v1'
    const api = createMockApi({
      readFile: async () => ({ kind: 'text', content, size: content.length, truncated: false }),
      listChanges: async () => {
        if (fail) throw new Error('offline')
        return { files: [] }
      },
    })
    const listChanges = vi.spyOn(api, 'listChanges')
    const onError = vi.fn()
    const { unmount } = render(<Harness api={api} initial={{ selected: 'src/app.ts' }} onError={onError} />)
    const flush = (ms = 0): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    await flush()
    expect(listChanges).toHaveBeenCalledTimes(1)
    expect(codeText()).toBe('v1')

    content = 'v2'
    await flush(PANEL_POLL_MS)
    expect(listChanges).toHaveBeenCalledTimes(2)
    expect(codeText()).toBe('v2')

    fail = true
    await flush(PANEL_POLL_MS)
    expect(screen.getByRole('button', { name: 'Refresh (last refresh failed)' })).toBeInTheDocument()
    expect(onError).not.toHaveBeenCalled()

    fail = false
    await flush(PANEL_POLL_MS)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()

    unmount()
    await flush(PANEL_POLL_MS * 3)
    expect(listChanges).toHaveBeenCalledTimes(4)
  })

  it('re-reads everything on ⟳', async () => {
    const user = userEvent.setup()
    const api = createMockApi()
    const listFiles = vi.spyOn(api, 'listFiles')
    render(<Harness api={api} />)
    await screen.findByRole('button', { name: 'README.md' })
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
  })
})
