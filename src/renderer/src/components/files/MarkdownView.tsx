import { memo, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { headingSlug, isExternal, lineFragment, linkFragment, resolveRelative } from '../../lib/markdown/paths'
import type { LineRange } from '../../lib/review'
import { MermaidBlock } from './MermaidBlock'
import { useLatestCallback } from '../../lib/useLatestCallback'

export interface MarkdownViewProps {
  source: string
  /** Path of the .md file relative to the root, used to resolve relative links/images. */
  filePath: string
  loadImage: (relPath: string) => Promise<string | null>
  /** Called with a root-relative path for links to other files inside the root, and the lines a `#L12` names. */
  onOpenLink: (relPath: string, lines?: LineRange) => void
  onOpenExternal: (url: string) => void
}

type HastNode = NonNullable<ExtraProps['node']>
type HastRoot = { type: 'root'; children: HastNode['children'] }

function textOf(node: HastNode | HastNode['children'][number]): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

/**
 * Gives every heading its GitHub anchor (see headingSlug) as `data-slug`, for `#anchor` links to scroll to. Not as
 * an id: a document's headings must not take ids the app's own elements have.
 */
function rehypeHeadingSlugs() {
  return (tree: HastRoot): void => {
    const seen = new Map<string, number>()
    const visit = (nodes: HastRoot['children']): void => {
      for (const node of nodes) {
        if (node.type !== 'element') continue
        if (/^h[1-6]$/.test(node.tagName)) {
          const base = headingSlug(textOf(node))
          const n = seen.get(base) ?? 0
          seen.set(base, n + 1)
          node.properties.dataSlug = n === 0 ? base : `${base}-${n}`
        } else visit(node.children)
      }
    }
    visit(tree.children)
  }
}

const remarkPlugins = [remarkGfm]
// Mermaid fences are rendered by MermaidBlock, so don't spend time highlighting them.
// NOTE: never add rehype-raw here; raw HTML in Markdown must stay inert.
const rehypePlugins: React.ComponentProps<typeof Markdown>['rehypePlugins'] = [
  [rehypeHighlight, { plainText: ['mermaid'] }],
  rehypeHeadingSlugs,
]

/** A link handled here (no href, so the browser can never follow it): a click or Enter calls `go`. */
function ActionLink(p: { title?: string; go: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <a
      role="link"
      tabIndex={0}
      className="md-link"
      title={p.title}
      onClick={(e) => {
        e.preventDefault()
        p.go()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          p.go()
        }
      }}
    >
      {p.children}
    </a>
  )
}

/** The source of a ```mermaid fence, or null if this <pre> is something else. */
function mermaidSource(pre: HastNode | undefined): string | null {
  const elements = pre?.children.filter((c) => c.type === 'element') ?? []
  if (elements.length !== 1) return null
  const code = elements[0]
  if (code.type !== 'element' || code.tagName !== 'code') return null
  const classes = code.properties.className
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return null
  return textOf(code).replace(/\n$/, '')
}

function MdImage({
  src,
  alt,
  title,
  filePath,
  loadImage,
}: {
  src: string | undefined
  alt: string | undefined
  title: string | undefined
  filePath: string
  loadImage: MarkdownViewProps['loadImage']
}): React.JSX.Element {
  const external = !!src && isExternal(src)
  const path = src && !external ? resolveRelative(filePath, src) : null
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    loadImage(path).then(
      (url) => !cancelled && setLoaded({ path, url }),
      () => !cancelled && setLoaded({ path, url: null }),
    )
    return () => {
      cancelled = true
    }
  }, [path, loadImage])

  const label = alt || src || 'image'
  if (path && loaded?.path === path && loaded.url) {
    return <img src={loaded.url} alt={alt ?? ''} title={title} />
  }
  if (path && loaded?.path !== path) {
    return (
      <span className="md-img-loading" title={`Loading ${path}`}>
        {label}
      </span>
    )
  }
  const reason = external
    ? `External images are not loaded: ${src}`
    : path
      ? `Image not found, unreadable or too large: ${path}`
      : `Unsupported image path: ${src ?? ''}`
  return (
    <span className="md-img-missing" title={reason}>
      {label}
    </span>
  )
}

/**
 * Memoized, and the components map only depends on `filePath`: callbacks are read through stable wrappers, so a
 * parent re-render with new callback identities doesn't make react-markdown remount links, images and diagrams.
 */
export const MarkdownView = memo(function MarkdownView({
  source,
  filePath,
  loadImage: loadImageProp,
  onOpenLink: onOpenLinkProp,
  onOpenExternal: onOpenExternalProp,
}: MarkdownViewProps): React.JSX.Element {
  const loadImage = useLatestCallback(loadImageProp)
  const onOpenLink = useLatestCallback(onOpenLinkProp)
  const onOpenExternal = useLatestCallback(onOpenExternalProp)
  const bodyRef = useRef<HTMLDivElement>(null)
  const components = useMemo<Components>(
    () => ({
      a({ href, title, children }) {
        // react-markdown's default urlTransform already blanks javascript:, data: etc.; in addition, only http(s)
        // URLs are ever put in the DOM as an href.
        if (href && isExternal(href)) {
          return (
            <a
              href={href}
              title={title ?? href}
              onClick={(e) => {
                e.preventDefault()
                onOpenExternal(href)
              }}
            >
              {children}
            </a>
          )
        }
        if (href?.startsWith('#')) {
          // A heading of this document.
          const slug = linkFragment(href)?.toLowerCase()
          const go = (): void => {
            const heading = [...(bodyRef.current?.querySelectorAll<HTMLElement>('[data-slug]') ?? [])].find(
              (h) => h.dataset.slug === slug,
            )
            if (heading && typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' })
          }
          return (
            <ActionLink title={title ?? href} go={go}>
              {children}
            </ActionLink>
          )
        }
        const path = href ? resolveRelative(filePath, href) : null
        if (path) {
          // `file.ts#L12-L20` opens the file at those lines.
          const lines = lineFragment(linkFragment(href as string))
          return (
            <ActionLink title={title ?? path} go={() => (lines ? onOpenLink(path, lines) : onOpenLink(path))}>
              {children}
            </ActionLink>
          )
        }
        return <span title={title}>{children}</span>
      },
      img({ src, alt, title }) {
        return (
          <MdImage
            src={typeof src === 'string' ? src : undefined}
            alt={alt}
            title={title}
            filePath={filePath}
            loadImage={loadImage}
          />
        )
      },
      pre({ node, children, ...rest }) {
        const mermaid = mermaidSource(node)
        if (mermaid !== null) return <MermaidBlock code={mermaid} />
        return <pre {...rest}>{children}</pre>
      },
    }),
    [filePath, loadImage, onOpenLink, onOpenExternal],
  )

  return (
    <div className="markdown-body" ref={bodyRef}>
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </Markdown>
    </div>
  )
})
