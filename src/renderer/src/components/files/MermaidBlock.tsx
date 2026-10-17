import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mermaid } from 'mermaid'

export interface MermaidBlockProps {
  code: string
}

type State = { status: 'loading' } | { status: 'ok'; svg: string } | { status: 'error'; message: string }

const XLINK = 'http://www.w3.org/1999/xlink'

let mermaidPromise: Promise<Mermaid> | null = null
let nextId = 0

/** Lazily import mermaid (its own chunk) and initialize it exactly once. */
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then(
    ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', suppressErrorRendering: true })
      return mermaid
    },
    (err: unknown) => {
      mermaidPromise = null // allow a retry on the next render
      throw err
    },
  )
  return mermaidPromise
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
  const [state, setState] = useState<State>({ status: 'loading' })
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++nextId}`
    setState({ status: 'loading' })
    loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(
        ({ svg }) => {
          if (!cancelled) setState({ status: 'ok', svg })
        },
        (err: unknown) => {
          document.getElementById(`d${id}`)?.remove() // mermaid's temporary render node, if left behind
          if (!cancelled) setState({ status: 'error', message: errorMessage(err) })
        },
      )
    return () => {
      cancelled = true
    }
  }, [code])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || state.status !== 'ok') return
    // Mermaid output is sanitized by mermaid itself (securityLevel: 'strict').
    el.innerHTML = state.svg
    neutralizeLinks(el)
  }, [state])

  if (state.status === 'error') {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-message">{state.message}</div>
        <pre>{code}</pre>
      </div>
    )
  }
  return (
    <div
      className={state.status === 'loading' ? 'mermaid-block mermaid-loading' : 'mermaid-block'}
      ref={containerRef}
      onClickCapture={(e) => {
        if ((e.target as Element).closest('a')) e.preventDefault()
      }}
    />
  )
}
