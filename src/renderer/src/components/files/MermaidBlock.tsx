import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mermaid } from 'mermaid'
import type { ResolvedAppearance } from '../../../../shared/types'
import { useResolvedAppearance } from '../../lib/appearance'

export interface MermaidBlockProps {
  code: string
}

/** The outcome of rendering `code`; a state for a different `code` than the current prop means "still loading". */
type Result = { code: string } & ({ status: 'ok'; svg: string } | { status: 'error'; message: string })

const XLINK = 'http://www.w3.org/1999/xlink'

/** Mermaid's built-in theme for each appearance. */
const MERMAID_THEME: Record<ResolvedAppearance, 'dark' | 'default'> = { dark: 'dark', light: 'default' }

let mermaidPromise: Promise<Mermaid> | null = null
/** The theme mermaid (a global) was last initialized with. */
let initializedTheme: string | null = null
let nextId = 0

/** Lazily import mermaid (its own chunk). */
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then(
    ({ default: mermaid }) => mermaid,
    (err: unknown) => {
      mermaidPromise = null // allow a retry on the next render
      throw err
    },
  )
  return mermaidPromise
}

/** Renders `code` in `theme`, (re)initializing mermaid first when it last had another theme. */
async function renderDiagram(id: string, code: string, theme: 'dark' | 'default'): Promise<string> {
  const mermaid = await loadMermaid()
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true })
    initializedTheme = theme
  }
  return (await mermaid.render(id, code)).svg
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String(err.message)
  return String(err)
}

/**
 * Strip navigation from anchors mermaid may emit (e.g. `click A href "..."`). DOMPurify (strict mode) keeps http(s)
 * hrefs, and following one would load a remote page into the app window, where the preload API is exposed.
 */
function neutralizeLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll('a')) {
    a.removeAttribute('href')
    a.removeAttributeNS(XLINK, 'href')
    a.removeAttribute('xlink:href')
    a.removeAttribute('target')
  }
}

export function MermaidBlock({ code }: MermaidBlockProps): React.JSX.Element {
  const [result, setResult] = useState<Result | null>(null)
  // Only a new `code` counts as loading: on an appearance change the old diagram stays until the new one is drawn.
  const state = result?.code === code ? result : null
  const theme = MERMAID_THEME[useResolvedAppearance()]
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++nextId}`
    renderDiagram(id, code, theme).then(
      (svg) => {
        if (!cancelled) setResult({ code, status: 'ok', svg })
      },
      (err: unknown) => {
        document.getElementById(`d${id}`)?.remove() // mermaid's temporary render node, if left behind
        if (!cancelled) setResult({ code, status: 'error', message: errorMessage(err) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [code, theme])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || state?.status !== 'ok') return
    // Mermaid output is sanitized by mermaid itself (securityLevel: 'strict').
    el.innerHTML = state.svg
    neutralizeLinks(el)
  }, [state])

  if (state?.status === 'error') {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-message">{state.message}</div>
        <pre>{code}</pre>
      </div>
    )
  }
  return (
    <div
      className={state ? 'mermaid-block' : 'mermaid-block mermaid-loading'}
      ref={containerRef}
      onClickCapture={(e) => {
        if ((e.target as Element).closest('a')) e.preventDefault()
      }}
    />
  )
}
