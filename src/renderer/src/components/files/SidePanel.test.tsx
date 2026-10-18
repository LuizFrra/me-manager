import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeManagerApi, SearchMatch, Target } from '../../../../shared/types'
import { createMockApi } from '../../api/mockApi'
import { DEFAULT_PANEL, type PanelState } from '../../lib/panelState'
import { PANEL_POLL_MS, SidePanel } from './SidePanel'

interface MdProps {
  source: string
  filePath: string
  loadImage: unknown
  onOpenLink: (path: string) => void
  onOpenExternal: unknown
}
const mdRenders = vi.hoisted(() => [] as MdProps[])
vi.mock('./MarkdownView', () => ({
  MarkdownView: (p: MdProps) => {
    mdRenders.push(p)
    return (
      <div data-testid="markdown">
        MD:{p.source}
        <button onClick={() => p.onOpenLink('docs/guide.md')}>link from {p.filePath}</button>
      </div>
    )
  },
}))
// Counts tree builds, to check that polls returning the same files don't rebuild the tree.
const treeBuilds = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../lib/fileTree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/fileTree')>()
  return {
    ...actual,
    buildTree: (paths: readonly string[]) => {
      treeBuilds.count++
      return actual.buildTree(paths)
    },
  }
})
vi.mock('./DiffView', () => ({
  DiffView: (p: { diff: string; layout?: string }) => (
    <pre data-testid="diff" data-layout={p.layout ?? 'unified'}>
      DIFF:{p.diff}
    </pre>
  ),
}))

const TASK: Target = { themeId: 't1', itemId: 'r1', taskId: 'k1' }
const FOLDER: Target = { themeId: 't1', itemId: 'f1' }

interface HarnessProps {
  api: MeManagerApi
  target?: Target
  isRepo?: boolean
  missing?: boolean
  initial?: Partial<PanelState>
  pollMs?: number
  onError?: (e: unknown) => void
}

function Harness({
  api,
  target = TASK,
  isRepo = true,
  missing = false,
  initial,
  pollMs,
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
      pollMs={pollMs}
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

  it('says when the file list was cut off at its cap', async () => {
    const { unmount } = render(
      <Harness api={createMockApi({ listFiles: async () => ({ paths: ['a.ts'], truncated: false }) })} />,
    )
    await screen.findByRole('button', { name: 'a.ts' })
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
    unmount()
    const paths = ['a.ts', 'b.ts', 'c.ts']
    const api = createMockApi({ listFiles: async () => ({ paths, truncated: true }) })
    render(<Harness api={api} />)
    expect(await screen.findByText('Showing the first 3 files.')).toBeInTheDocument()
  })

  it('formats the truncation count with thousands separators', async () => {
    const paths = Array.from({ length: 1234 }, (_, i) => `f${i}.txt`)
    render(<Harness api={createMockApi({ listFiles: async () => ({ paths, truncated: true }) })} />)
    expect(await screen.findByText('Showing the first 1,234 files.')).toBeInTheDocument()
  })

  it('shows binary, missing, folder-symlink and truncated files', async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      listFiles: async () => ({ paths: ['big.log', 'gone.ts', 'blob.bin', 'linked'], truncated: false }),
      readFile: async (_t, path) =>
        path === 'blob.bin'
          ? { kind: 'binary', size: 2048 }
          : path === 'big.log'
            ? { kind: 'text', content: 'start', size: 1_500_000, truncated: true }
            : path === 'linked'
              ? { kind: 'symlinkToFolder' }
              : { kind: 'missing' },
    })
    render(<Harness api={api} />)
    await user.click(await screen.findByRole('button', { name: 'blob.bin' }))
    expect(await screen.findByText('Binary file (2.0 KB)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'gone.ts' }))
    expect(await screen.findByText('File no longer exists')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'linked' }))
    expect(await screen.findByText('Symlink to a folder')).toBeInTheDocument()
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

  it('passes MarkdownView the same callbacks when the panel re-renders', async () => {
    const user = userEvent.setup()
    const api = createMockApi()
    const { rerender } = render(<Harness api={api} />)
    await user.click(await screen.findByRole('button', { name: 'README.md' }))
    await screen.findByTestId('markdown')
    const first = mdRenders.at(-1)!
    rerender(<Harness api={api} onError={() => {}} />)
    await user.type(screen.getByRole('textbox', { name: 'Filter files' }), 'R')
    const last = mdRenders.at(-1)!
    expect(last).not.toBe(first)
    expect(last.onOpenLink).toBe(first.onOpenLink)
    expect(last.loadImage).toBe(first.loadImage)
    expect(last.onOpenExternal).toBe(first.onOpenExternal)
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

  describe('diff layout', () => {
    /** Node's own `localStorage` shadows jsdom's and needs a file, so these tests bring one. */
    function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
      const data = new Map<string, string>()
      return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, String(v)) }
    }
    const layoutToggle = (): HTMLElement => screen.getByRole('group', { name: 'Diff layout' })
    const pressed = (): string[] =>
      within(layoutToggle())
        .getAllByRole('button', { pressed: true })
        .map((b) => b.textContent ?? '')
    /** Opens Changes and the first changed file's diff. */
    async function openDiff(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
      await user.click(await screen.findByRole('tab', { name: 'Changes 4' }))
      await user.click(screen.getByRole('button', { name: /src\/app\.ts/ }))
      return screen.findByTestId('diff')
    }

    beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('starts unified in a narrow panel, and the toggle switches to split and back', async () => {
      const user = userEvent.setup()
      render(<Harness api={createMockApi()} />)
      expect(await openDiff(user)).toHaveAttribute('data-layout', 'unified')
      expect(pressed()).toEqual(['Unified'])
      await user.click(within(layoutToggle()).getByRole('button', { name: 'Split' }))
      expect(screen.getByTestId('diff')).toHaveAttribute('data-layout', 'split')
      expect(pressed()).toEqual(['Split'])
      await user.click(within(layoutToggle()).getByRole('button', { name: 'Unified' }))
      expect(screen.getByTestId('diff')).toHaveAttribute('data-layout', 'unified')
    })

    it('starts split in a panel wider than 700 px', async () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 900 } as DOMRect)
      const user = userEvent.setup()
      render(<Harness api={createMockApi()} />)
      expect(await openDiff(user)).toHaveAttribute('data-layout', 'split')
      expect(pressed()).toEqual(['Split'])
    })

    it('keeps the picked layout for every panel after, whatever its width', async () => {
      const wide = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 900 } as DOMRect)
      const user = userEvent.setup()
      const { unmount } = render(<Harness api={createMockApi()} />)
      await openDiff(user)
      await user.click(within(layoutToggle()).getByRole('button', { name: 'Unified' }))
      unmount()

      render(<Harness api={createMockApi()} target={{ ...TASK, taskId: 'k2' }} />)
      expect(await openDiff(user)).toHaveAttribute('data-layout', 'unified')
      expect(localStorage.getItem('me-manager.diffLayout')).toBe('unified')
      wide.mockRestore()
    })

    it('has no layout toggle in Files', async () => {
      render(<Harness api={createMockApi()} />)
      await screen.findByRole('button', { name: 'README.md' })
      expect(screen.queryByRole('group', { name: 'Diff layout' })).not.toBeInTheDocument()
    })
  })

  it('allows Open file for a deletion whose file is still on disk', async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      listChanges: async () => ({
        files: [
          { path: 'src/app.ts', status: 'D', added: 0, removed: 3, binary: false, existsOnDisk: true },
          { path: 'src/legacy.ts', status: 'D', added: 0, removed: 3, binary: false },
        ],
      }),
    })
    render(<Harness api={api} />)
    await user.click(await screen.findByRole('tab', { name: 'Changes 2' }))
    await user.click(screen.getByRole('button', { name: /src\/legacy\.ts/ }))
    expect(await screen.findByRole('button', { name: 'Open file' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /src\/app\.ts/ }))
    expect(screen.getByRole('button', { name: 'Open file' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Open file' }))
    await vi.waitFor(() => expect(codeText()).toContain('greetAll'))
  })

  it("passes a rename's oldPath to fileDiff", async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      listChanges: async () => ({
        files: [{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R', added: 1, removed: 0, binary: false }],
      }),
    })
    const fileDiff = vi.spyOn(api, 'fileDiff')
    render(<Harness api={api} />)
    await user.click(await screen.findByRole('tab', { name: 'Changes 1' }))
    await user.click(screen.getByRole('button', { name: /src\/new\.ts/ }))
    expect(fileDiff).toHaveBeenCalledWith(TASK, 'src/new.ts', 'src/old.ts')
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

  it("doesn't rebuild the tree on polls that list the same files, nor when the filter is cleared", async () => {
    vi.useFakeTimers()
    let version = 0
    let paths = ['README.md', 'src/app.ts', 'src/util/format.ts']
    const api = createMockApi({
      // A new change list every poll, so the file list is fetched every time, as a fresh but equal array.
      listChanges: async () => ({
        files: [{ path: `x${++version}`, status: 'U', added: 0, removed: 0, binary: false }],
      }),
      listFiles: async () => ({ paths: [...paths], truncated: false }),
    })
    const listFiles = vi.spyOn(api, 'listFiles')
    render(<Harness api={api} />)
    const flush = (ms = 0): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    await flush()
    const builds = treeBuilds.count
    expect(builds).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) await flush(PANEL_POLL_MS)
    expect(listFiles.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(treeBuilds.count).toBe(builds)

    paths = [...paths, 'docs/new.md']
    await flush(PANEL_POLL_MS)
    expect(treeBuilds.count).toBe(builds + 1)
    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument()

    vi.useRealTimers()
    const user = userEvent.setup()
    const filterBox = screen.getByRole('textbox', { name: 'Filter files' })
    await user.type(filterBox, 'a')
    const afterTyping = treeBuilds.count
    await user.clear(filterBox)
    expect(treeBuilds.count).toBe(afterTyping) // the full list's tree, from the cache
    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument()
  })

  it('polls at the interval it is given', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const listChanges = vi.spyOn(api, 'listChanges')
    render(<Harness api={api} pollMs={10_000} />)
    const flush = (ms = 0): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    await flush()
    expect(listChanges).toHaveBeenCalledTimes(1)
    await flush(PANEL_POLL_MS * 3)
    expect(listChanges).toHaveBeenCalledTimes(1)
    await flush(1_000)
    expect(listChanges).toHaveBeenCalledTimes(2)
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

  describe('Search tab', () => {
    const match = (
      path: string,
      line: number,
      preview: string,
      matchStart: number,
      matchLength: number,
    ): SearchMatch => ({
      path,
      line,
      column: matchStart + 1,
      preview,
      matchStart,
      matchLength,
    })

    it('is there for repos and folders', async () => {
      render(<Harness api={createMockApi()} target={FOLDER} isRepo={false} />)
      expect(await screen.findByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'false')
    })

    it('searches once typing pauses, then lists the results grouped by file with the match highlighted', async () => {
      const user = userEvent.setup()
      const api = createMockApi()
      const search = vi.spyOn(api, 'searchFiles')
      render(<Harness api={api} />)
      await user.click(await screen.findByRole('tab', { name: 'Search' }))
      const input = screen.getByRole('textbox', { name: 'Search in files' })
      expect(input).toHaveFocus()
      await user.type(input, 'formatName')
      expect(await screen.findByText('4 results in 3 files')).toBeInTheDocument()
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith(TASK, 'formatName', { caseSensitive: false, regex: false })
      const groups = [...document.querySelectorAll('.search-file')].map((b) => b.textContent)
      expect(groups).toEqual(['▸notes.txt1', '▸app.tssrc2', '▸format.tssrc/util1'])
      const hit = screen.getByRole('button', { name: /^notes\.txt, line 1:/ })
      expect(hit.querySelector('mark')).toHaveTextContent(/^formatName$/)
      // A file's results fold away.
      await user.click(screen.getByRole('button', { name: /app\.ts/, expanded: true }))
      expect(screen.queryByRole('button', { name: /^src\/app\.ts, line/ })).not.toBeInTheDocument()
    })

    it('searches at once on Enter, and again when a toggle changes', async () => {
      const user = userEvent.setup()
      const api = createMockApi()
      const search = vi.spyOn(api, 'searchFiles')
      render(<Harness api={api} initial={{ tab: 'search' }} />)
      const input = await screen.findByRole('textbox', { name: 'Search in files' })
      await user.type(input, 'greet{Enter}')
      expect(search).toHaveBeenCalledTimes(1)
      await act(() => new Promise((r) => setTimeout(r, 400)))
      expect(search).toHaveBeenCalledTimes(1)
      await user.click(screen.getByRole('button', { name: 'Match case' }))
      await vi.waitFor(() =>
        expect(search).toHaveBeenLastCalledWith(TASK, 'greet', { caseSensitive: true, regex: false }),
      )
      await user.click(screen.getByRole('button', { name: 'Use regular expression' }))
      await vi.waitFor(() =>
        expect(search).toHaveBeenLastCalledWith(TASK, 'greet', { caseSensitive: true, regex: true }),
      )
      expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('shows an invalid pattern inline, and says when results were capped', async () => {
      const user = userEvent.setup()
      let fail = true
      const api = createMockApi({
        searchFiles: async () => {
          if (fail)
            throw new Error(
              "Error invoking remote method 'api:searchFiles': Error: Invalid regular expression: Unterminated group",
            )
          return { matches: [match('a.ts', 1, 'x', 0, 1)], truncated: true }
        },
      })
      const onError = vi.fn()
      render(<Harness api={api} initial={{ tab: 'search' }} onError={onError} />)
      await user.type(await screen.findByRole('textbox', { name: 'Search in files' }), '(x{Enter}')
      expect(await screen.findByRole('alert')).toHaveTextContent(/^Invalid regular expression: Unterminated group$/)
      expect(onError).not.toHaveBeenCalled()
      fail = false
      await user.type(screen.getByRole('textbox', { name: 'Search in files' }), '{Enter}')
      expect(await screen.findByText('This folder is very large: not every file was searched.')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('opens a result in Files at its line', async () => {
      const user = userEvent.setup()
      const api = createMockApi()
      render(
        <Harness
          api={api}
          initial={{ tab: 'search', search: { query: 'greetAll', caseSensitive: false, regex: false } }}
        />,
      )
      await user.click(await screen.findByRole('button', { name: /^src\/app\.ts, line 9:/ }))
      expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
      await vi.waitFor(() => expect(codeText()).toContain('greetAll'))
      expect(document.querySelector('.code-line-mark')).toHaveAttribute('data-line', '9')
      expect(fileButton('app\\.ts')).toHaveAttribute('aria-current', 'true')
      // Picking another file drops the mark.
      await user.click(screen.getByRole('button', { name: 'README.md' }))
      await vi.waitFor(() => expect(document.querySelector('.code-line-mark')).toBeNull())
    })
  })
})
