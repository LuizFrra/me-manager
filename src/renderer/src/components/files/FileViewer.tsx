import 'highlight.js/styles/github-dark.css'
import { useCallback } from 'react'
import type { ChangedFile, FileContent, MeManagerApi, Target } from '../../../../shared/types'
import type { PanelState, PanelTab } from '../../lib/panelState'
import { isImagePath, isSvgPath } from '../../../../shared/images'
import { formatSize, isMarkdown } from '../../lib/files'
import { CodeView } from './CodeView'
import { DiffView } from './DiffView'
import { ImageView } from './ImageView'
import { MarkdownView } from './MarkdownView'
import { useLatestCallback } from '../../lib/useLatestCallback'

export interface FileViewerProps {
  api: Pick<MeManagerApi, 'readImage' | 'openExternal'>
  target: Target
  tab: PanelTab
  path?: string
  /** Files tab: the file's content; undefined while loading. */
  content?: FileContent
  /** Changes tab: the diff text; undefined while loading. */
  diff?: string
  /** Changes tab: the selected change. */
  change?: ChangedFile
  mdMode: PanelState['mdMode']
  /** Files tab: a line to scroll to and highlight (a search result). */
  highlightLine?: number
  canGoBack: boolean
  onBack: () => void
  onMdMode: (mode: PanelState['mdMode']) => void
  onOpenLink: (path: string) => void
  onOpenFile: (path: string) => void
  onError: (err: unknown) => void
}

export function FileViewer(p: FileViewerProps): React.JSX.Element {
  const { api, target } = p
  const onError = useLatestCallback(p.onError)
  const loadImage = useCallback((rel: string) => api.readImage(target, rel), [api, target])
  const openExternal = useCallback((url: string) => void api.openExternal(url).catch(onError), [api, onError])

  if (!p.path) {
    return (
      <section className="viewer viewer-empty">
        {p.tab === 'changes' ? 'Select a changed file to see its diff.' : 'Select a file to view it.'}
      </section>
    )
  }

  const path = p.path
  // A deletion can still be opened when only git forgot the file (`git rm --cached`).
  const gone = p.change?.status === 'D' && !p.change.existsOnDisk
  const md = p.tab === 'files' && isMarkdown(path) && p.content?.kind === 'text'
  // An SVG is text: it can be shown as an image (the default) or as its source, like Markdown.
  const svg = p.tab === 'files' && isSvgPath(path) && p.content?.kind === 'text'
  const image = isImagePath(path)

  let body: React.ReactNode
  if (p.tab === 'changes') {
    const diff = p.diff === undefined ? <p className="panel-hint">Loading…</p> : <DiffView diff={p.diff} />
    // A changed image: its new version, when there is one, above the diff ("Binary file changed").
    const current = p.change && (p.change.status !== 'D' || p.change.existsOnDisk)
    body =
      image && current ? (
        <>
          <ImageView key={path} path={path} load={loadImage} compact label="New version" />
          {diff}
        </>
      ) : (
        diff
      )
  } else if (!p.content) {
    body = <p className="panel-hint">Loading…</p>
  } else if (p.content.kind === 'missing') {
    body = <p className="viewer-message">File no longer exists</p>
  } else if (p.content.kind === 'symlinkToFolder') {
    body = <p className="viewer-message">Symlink to a folder</p>
  } else if (image && (p.content.kind === 'binary' || (p.content.kind === 'text' && p.mdMode === 'view'))) {
    body = <ImageView key={path} path={path} size={p.content.size} load={loadImage} />
  } else if (p.content.kind === 'binary') {
    body = <p className="viewer-message">Binary file ({formatSize(p.content.size)})</p>
  } else {
    const text = p.content
    body = (
      <>
        {text.truncated && (
          <div className="panel-notice">Large file ({formatSize(text.size)}): only the beginning is shown.</div>
        )}
        {md && p.mdMode === 'view' ? (
          <div className="viewer-md">
            <MarkdownView
              source={text.content}
              filePath={path}
              loadImage={loadImage}
              onOpenLink={p.onOpenLink}
              onOpenExternal={openExternal}
            />
          </div>
        ) : (
          <CodeView path={path} content={text.content} highlightLine={p.highlightLine} />
        )}
      </>
    )
  }

  return (
    <section className="viewer" aria-label="File viewer">
      <div className="viewer-header">
        {p.canGoBack && p.tab === 'files' && (
          <button className="viewer-btn" onClick={p.onBack} title="Back to the previous file">
            ← Back
          </button>
        )}
        <span className="viewer-path" title={path}>
          {p.change?.oldPath ? `${p.change.oldPath} → ${path}` : path}
        </span>
        {(md || svg) && (
          <div className="segmented" role="group" aria-label={md ? 'Markdown mode' : 'SVG mode'}>
            <button aria-pressed={p.mdMode === 'view'} onClick={() => p.onMdMode('view')}>
              {md ? 'View' : 'Image'}
            </button>
            <button aria-pressed={p.mdMode === 'raw'} onClick={() => p.onMdMode('raw')}>
              {md ? 'Raw' : 'Source'}
            </button>
          </div>
        )}
        {p.tab === 'changes' && (
          <button
            className="viewer-btn"
            disabled={gone}
            title={
              gone
                ? 'The file was deleted'
                : p.change?.status === 'D'
                  ? 'Removed from git, but still on disk: show the file'
                  : 'Show the whole file'
            }
            onClick={() => p.onOpenFile(path)}
          >
            Open file
          </button>
        )}
      </div>
      <div className="viewer-body">{body}</div>
    </section>
  )
}
