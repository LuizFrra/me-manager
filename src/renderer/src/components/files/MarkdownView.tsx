import { useEffect, useMemo, useState } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { isExternal, resolveRelative } from '../../lib/markdown/paths'
import { MermaidBlock } from './MermaidBlock'

export interface MarkdownViewProps {
  source: string
  /** Path of the .md file relative to the root, used to resolve relative links/images. */
  filePath: string
  loadImage: (relPath: string) => Promise<string | null>
  /** Called with a root-relative path for links to other files inside the root. */
  onOpenLink: (relPath: string) => void
  onOpenExternal: (url: string) => void
}

type HastNode = NonNullable<ExtraProps['node']>

const remarkPlugins = [remarkGfm]
// Mermaid fences are rendered by MermaidBlock, so don't spend time highlighting them.
// NOTE: never add rehype-raw here; raw HTML in Markdown must stay inert.
const rehypePlugins: React.ComponentProps<typeof Markdown>['rehypePlugins'] = [
  [rehypeHighlight, { plainText: ['mermaid'] }],
]

function textOf(node: HastNode | HastNode['children'][number]): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
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

export function MarkdownView({
  source,
  filePath,
  loadImage,
  onOpenLink,
  onOpenExternal,
}: MarkdownViewProps): React.JSX.Element {
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
        const path = href ? resolveRelative(filePath, href) : null
        if (path) {
          // No href: an in-root path must never be navigable by the browser (middle-click, drag, etc.).
          return (
            <a
              role="link"
              tabIndex={0}
              className="md-link"
              title={title ?? path}
              onClick={(e) => {
                e.preventDefault()
                onOpenLink(path)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onOpenLink(path)
                }
              }}
            >
              {children}
            </a>
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
    <div className="markdown-body">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </Markdown>
    </div>
  )
}
