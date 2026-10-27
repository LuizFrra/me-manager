import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ChangedFile, FileContent, MeManagerApi, Target } from '../../../../shared/types'
import type { PanelState, PanelTab } from '../../lib/panelState'
import { isImagePath, isSvgPath } from '../../../../shared/images'
import { formatSize, isMarkdown } from '../../lib/files'
import type { DiffLayout } from '../../lib/diff/layout'
import { CodeView } from './CodeView'
import { DiffView } from './DiffView'
import { ImageView } from './ImageView'
import { MarkdownView } from './MarkdownView'
import { useLatestCallback } from '../../lib/useLatestCallback'
import type { LineSelection, LineSelectProps } from '../../lib/lineSelection'
import { selectedLinesLabel, type ReviewDraft, type SelectedLines } from '../../lib/review'

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
  /** Why the file or diff couldn't be read (instead of `content` or `diff`). */
  error?: string
  mdMode: PanelState['mdMode']
  /** Changes tab: how the diff is laid out; unified by default. */
  diffLayout?: DiffLayout
  /** Changes tab: the user picked a layout with the header's Unified / Split toggle. */
  onDiffLayout?: (layout: DiffLayout) => void
  /** Files tab: a line to scroll to and highlight (a search result). */
  highlightLine?: number
  canGoBack: boolean
  onBack: () => void
  onMdMode: (mode: PanelState['mdMode']) => void
  onOpenLink: (path: string) => void
  onOpenFile: (path: string) => void
  onError: (err: unknown) => void
  /**
   * Lines of the code view and the diff can be selected and commented on: called with what the comment is about,
   * and `done`, which clears the selection (once the comment is saved).
   */
  onComment?: (draft: ReviewDraft, done: () => void) => void
}

/**
 * The selected lines, with what they were selected in: the file's content or the diff text, as loaded. A new
 * version (a poll brought changes), another file or the other tab drops the selection, as its rows may have moved.
 */
interface ViewSelection {
  /** `<tab>:<path>`. */
  key: string
  source: unknown
  selection: LineSelection
  lines: SelectedLines
}

export function FileViewer(p: FileViewerProps): React.JSX.Element {
  const { api, target } = p
  const onError = useLatestCallback(p.onError)
  const loadImage = useCallback((rel: string) => api.readImage(target, rel), [api, target])
  const openExternal = useCallback((url: string) => void api.openExternal(url).catch(onError), [api, onError])
  const sectionRef = useRef<HTMLElement>(null)
  const [viewSel, setViewSel] = useState<ViewSelection | null>(null)
  const source = p.tab === 'changes' ? p.diff : p.content
  const selKey = `${p.tab}:${p.path}`
  const current =
    viewSel && source !== undefined && viewSel.key === selKey && viewSel.source === source ? viewSel : null
  const comment = (): void => {
    if (!current || !p.path || !p.onComment || p.tab === 'search') return
    // The dialog gives focus back to what had it: the line numbers, not the Comment button about to disappear.
    sectionRef.current?.querySelector<HTMLElement>('[data-line-select]')?.focus({ preventScroll: true })
    const done = (): void => setViewSel((s) => (s === current ? null : s))
    p.onComment({ path: p.path, tab: p.tab, ...current.lines }, done)
  }
  // The body scrolls for every file: another file (or the other tab) starts at its top, not where the last one was.
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = 0
    el.scrollLeft = 0
  }, [selKey])
  const select: LineSelectProps | undefined = p.onComment && {
    selection: current?.selection ?? null,
    onSelect: (selection, lines) => setViewSel(selection && lines ? { key: selKey, source, selection, lines } : null),
    onComment: comment,
  }

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
  if (p.error !== undefined) {
    body = (
      <p className="viewer-message" role="alert">
        Can&apos;t show this {p.tab === 'changes' ? 'diff' : 'file'}: {p.error}
      </p>
    )
  } else if (p.tab === 'changes') {
    const diff =
      p.diff === undefined ? (
        <p className="panel-hint">Loading…</p>
      ) : (
        <DiffView diff={p.diff} layout={p.diffLayout} select={select} />
      )
    // A changed image: its new version, when there is one, above the diff ("Binary file changed"). The diff names
    // the version (git's blob ids), so the image is read again when it changes.
    const current = p.change && (p.change.status !== 'D' || p.change.existsOnDisk)
    body =
      image && current && p.diff !== undefined ? (
        <>
          <ImageView key={path} path={path} load={loadImage} compact label="New version" version={p.diff} />
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
    // An SVG's text says which version it is (an edit may keep its size).
    const version = p.content.kind === 'text' ? p.content.content : undefined
    body = <ImageView key={path} path={path} size={p.content.size} load={loadImage} version={version} />
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
          <CodeView path={path} content={text.content} highlightLine={p.highlightLine} select={select} />
        )}
      </>
    )
  }

  const label = current && selectedLinesLabel(current.lines)
  return (
    <section className={label ? 'viewer has-selection' : 'viewer'} aria-label="File viewer" ref={sectionRef}>
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
        {p.tab === 'changes' && p.onDiffLayout && (
          <div className="segmented" role="group" aria-label="Diff layout">
            {(['unified', 'split'] as const).map((layout) => (
              <button
                key={layout}
                aria-pressed={(p.diffLayout ?? 'unified') === layout}
                title={layout === 'split' ? 'Old and new side by side' : 'Old and new in one column'}
                onClick={() => p.onDiffLayout?.(layout)}
              >
                {layout === 'split' ? 'Split' : 'Unified'}
              </button>
            ))}
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
      {p.onComment && (
        <span className="sr-only viewer-selection-status" aria-live="polite">
          {label && `${label} selected`}
        </span>
      )}
      <div className="viewer-body" ref={bodyRef}>
        {body}
      </div>
      {label && (
        <div className="viewer-selection">
          <span className="viewer-selection-label">{label}</span>
          <span className="viewer-selection-hint">C to comment · Esc to clear</span>
          <button className="viewer-btn primary" title="Comment on the selected lines (C)" onClick={comment}>
            Comment
          </button>
          <button
            className="panel-icon"
            aria-label="Clear the line selection"
            title="Clear the selection (Esc)"
            onClick={() => setViewSel(null)}
          >
            ✕
          </button>
        </div>
      )}
    </section>
  )
}
