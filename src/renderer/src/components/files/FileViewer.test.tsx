import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { MAX_IMAGE_BYTES } from '../../../../shared/images'
import type { ChangedFile, FileContent, Target } from '../../../../shared/types'
import { FileViewer, type FileViewerProps } from './FileViewer'

vi.mock('./DiffView', () => ({ DiffView: (p: { diff: string }) => <pre data-testid="diff">DIFF:{p.diff}</pre> }))
vi.mock('./MarkdownView', () => ({ MarkdownView: () => <div data-testid="markdown" /> }))

const TARGET: Target = { themeId: 't', itemId: 'r', taskId: 'k' }
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo='
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>\n'

function renderViewer(
  over: Partial<FileViewerProps> & { readImage?: (t: Target, p: string) => Promise<string | null> },
): ReturnType<typeof render> & { readImage: Mock<(t: Target, p: string) => Promise<string | null>> } {
  const readImage = vi.fn(over.readImage ?? (async () => PNG_URL))
  const props: FileViewerProps = {
    api: { readImage, openExternal: async () => {} },
    target: TARGET,
    tab: 'files',
    mdMode: 'view',
    canGoBack: false,
    onBack: () => {},
    onMdMode: () => {},
    onOpenLink: () => {},
    onOpenFile: () => {},
    onError: () => {},
    ...over,
  }
  return { readImage, ...render(<FileViewer {...props} />) }
}

const binary = (size: number): FileContent => ({ kind: 'binary', size })

describe('FileViewer images', () => {
  it('shows a png through readImage, with its size and, once loaded, its dimensions', async () => {
    const { readImage } = renderViewer({ path: 'img/logo.png', content: binary(2048) })
    const img = await screen.findByRole('img', { name: 'logo.png' })
    expect(img).toHaveAttribute('src', PNG_URL)
    expect(readImage).toHaveBeenCalledWith(TARGET, 'img/logo.png')
    expect(screen.queryByText(/Binary file/)).not.toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    Object.defineProperty(img, 'naturalWidth', { value: 640 })
    Object.defineProperty(img, 'naturalHeight', { value: 480 })
    fireEvent.load(img)
    expect(screen.getByText('640 × 480 px · 2.0 KB')).toBeInTheDocument()
  })

  it('fits the image by default and switches to 100%', async () => {
    const user = userEvent.setup()
    renderViewer({ path: 'a.JPG', content: binary(100) })
    const img = await screen.findByRole('img', { name: 'a.JPG' })
    const fit = screen.getByRole('button', { name: 'Fit' })
    expect(fit).toHaveAttribute('aria-pressed', 'true')
    expect(img.parentElement).toHaveClass('image-stage zoom-fit')
    await user.click(screen.getByRole('button', { name: '100%' }))
    expect(screen.getByRole('button', { name: '100%' })).toHaveAttribute('aria-pressed', 'true')
    expect(img.parentElement).toHaveClass('image-stage zoom-actual')
  })

  it('does not even read an image over the limit', () => {
    const { readImage } = renderViewer({ path: 'huge.webp', content: binary(MAX_IMAGE_BYTES + 1_000_000) })
    expect(screen.getByText('Image too large to preview (5.7 MB)')).toBeInTheDocument()
    expect(readImage).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('says why when readImage gives nothing back, or the image does not decode', async () => {
    renderViewer({ path: 'a.gif', content: binary(10), readImage: async () => null })
    expect(await screen.findByText("Can't preview this image: it could not be read.")).toBeInTheDocument()
    renderViewer({ path: 'b.bmp', content: binary(10) })
    fireEvent.error(await screen.findByRole('img', { name: 'b.bmp' }))
    expect(screen.getByText(/could not be displayed/)).toBeInTheDocument()
  })

  it('renders an SVG as an <img> only, never as inline markup, and shows its source on request', async () => {
    const svgUrl = `data:image/svg+xml;base64,${btoa(SVG_SOURCE)}`
    const onMdMode = vi.fn()
    const content: FileContent = { kind: 'text', content: SVG_SOURCE, size: SVG_SOURCE.length, truncated: false }
    const { container, rerender } = renderViewer({
      path: 'icon.svg',
      content,
      onMdMode,
      readImage: async () => svgUrl,
    })
    const img = await screen.findByRole('img', { name: 'icon.svg' })
    expect(img.tagName).toBe('IMG')
    expect(img).toHaveAttribute('src', svgUrl)
    expect(container.querySelector('svg, script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(onMdMode).toHaveBeenCalledWith('raw')
    rerender(
      <FileViewer
        api={{ readImage: async () => svgUrl, openExternal: async () => {} }}
        target={TARGET}
        tab="files"
        path="icon.svg"
        content={content}
        mdMode="raw"
        canGoBack={false}
        onBack={() => {}}
        onMdMode={onMdMode}
        onOpenLink={() => {}}
        onOpenFile={() => {}}
        onError={() => {}}
      />,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('.code-body')?.textContent).toContain('<script>alert(1)</script>')
    expect(container.querySelector('svg, script')).toBeNull()
  })

  it('shows the new version of a changed image above the binary diff', async () => {
    const change: ChangedFile = { path: 'img/logo.png', status: 'M', added: 0, removed: 0, binary: true }
    renderViewer({ tab: 'changes', path: 'img/logo.png', change, diff: 'Binary files differ' })
    const img = await screen.findByRole('img', { name: 'logo.png' })
    expect(screen.getByText('New version')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument()
    // The image comes first, then the diff.
    expect(img.compareDocumentPosition(screen.getByTestId('diff')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reads a changed image again when its diff or its source changes', async () => {
    const change: ChangedFile = { path: 'img/logo.png', status: 'M', added: 0, removed: 0, binary: true }
    let n = 0
    const readImage = vi.fn(async () => `data:image/png;base64,v${++n}`)
    const api = { readImage, openExternal: async () => {} }
    const at = (over: Partial<FileViewerProps>): React.JSX.Element => (
      <FileViewer
        api={api}
        target={TARGET}
        tab="changes"
        path="img/logo.png"
        change={change}
        mdMode="view"
        canGoBack={false}
        onBack={() => {}}
        onMdMode={() => {}}
        onOpenLink={() => {}}
        onOpenFile={() => {}}
        onError={() => {}}
        {...over}
      />
    )
    const diff = (index: string): string =>
      `diff --git a/img/logo.png b/img/logo.png\nindex ${index} 100644\nBinary files a/img/logo.png and b/img/logo.png differ\n`
    // Not before the diff is in: it says which version the image is.
    const { rerender } = render(at({ diff: undefined }))
    expect(readImage).not.toHaveBeenCalled()
    rerender(at({ diff: diff('f584f40..6bf43ff') }))
    expect(await screen.findByRole('img', { name: 'logo.png' })).toHaveAttribute('src', 'data:image/png;base64,v1')
    rerender(at({ diff: diff('f584f40..6bf43ff') }))
    expect(readImage).toHaveBeenCalledTimes(1)
    rerender(at({ diff: diff('f584f40..0aa0f34') }))
    // The last version stays while the new one is read.
    expect(screen.getByRole('img', { name: 'logo.png' })).toHaveAttribute('src', 'data:image/png;base64,v1')
    await vi.waitFor(() =>
      expect(screen.getByRole('img', { name: 'logo.png' })).toHaveAttribute('src', 'data:image/png;base64,v2'),
    )

    // An SVG edited without changing its size (a colour swapped) in the Files tab.
    const svg = (fill: string): FileContent => {
      const content = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${fill}"/></svg>`
      return { kind: 'text', content, size: content.length, truncated: false }
    }
    rerender(at({ tab: 'files', path: 'icon.svg', change: undefined, diff: undefined, content: svg('#ff0000') }))
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(3))
    rerender(at({ tab: 'files', path: 'icon.svg', change: undefined, diff: undefined, content: svg('#00ff00') }))
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(4))
    expect(await screen.findByRole('img', { name: 'icon.svg' })).toHaveAttribute('src', 'data:image/png;base64,v4')
  })

  it('shows no image for a deleted one', () => {
    const change: ChangedFile = { path: 'old.png', status: 'D', added: 0, removed: 0, binary: true }
    const { readImage } = renderViewer({ tab: 'changes', path: 'old.png', change, diff: 'Binary files differ' })
    expect(screen.queryByText('New version')).not.toBeInTheDocument()
    expect(readImage).not.toHaveBeenCalled()
  })
})

describe('FileViewer scrolling', () => {
  const text = (content: string): FileContent => ({ kind: 'text', content, size: content.length, truncated: false })
  const props = (over: Partial<FileViewerProps>): FileViewerProps => ({
    api: { readImage: async () => null, openExternal: async () => {} },
    target: TARGET,
    tab: 'files',
    mdMode: 'view',
    canGoBack: false,
    onBack: () => {},
    onMdMode: () => {},
    onOpenLink: () => {},
    onOpenFile: () => {},
    onError: () => {},
    ...over,
  })

  it('opens another file at its top, but keeps the place when the same file is read again', () => {
    const { container, rerender } = render(<FileViewer {...props({ path: 'a.ts', content: text('a\n') })} />)
    const body = container.querySelector('.viewer-body') as HTMLElement
    body.scrollTop = 500
    body.scrollLeft = 40
    rerender(<FileViewer {...props({ path: 'a.ts', content: text('a changed\n') })} />)
    expect(body.scrollTop).toBe(500)
    rerender(<FileViewer {...props({ path: 'b.ts', content: undefined })} />)
    expect(body.scrollTop).toBe(0)
    expect(body.scrollLeft).toBe(0)
    body.scrollTop = 300
    rerender(<FileViewer {...props({ tab: 'changes', path: 'b.ts', diff: '' })} />)
    expect(body.scrollTop).toBe(0)
  })
})
