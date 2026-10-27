import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_SEARCH_MATCHES, MAX_SEARCH_QUERY } from '../../../../shared/search'
import type { MeManagerApi, SearchMatch, SearchResult, Target } from '../../../../shared/types'
import type { SearchState } from '../../lib/panelState'
import { shortcutLabel } from '../../lib/shortcuts'
import { cleanError } from '../../lib/toasts'
import { useLatestCallback } from '../../lib/useLatestCallback'

/** Typing waits this long for a pause before searching; Enter searches at once. */
export const SEARCH_DEBOUNCE_MS = 300

export interface SearchViewProps {
  api: Pick<MeManagerApi, 'searchFiles'>
  target: Target
  state: SearchState
  onState: (s: SearchState) => void
  onOpen: (match: SearchMatch) => void
  /** Bumped by the panel's ⟳: searches again. */
  reload: number
  /** Bumped to ask for the input's focus; `takeFocus` says whether this bump is one (and consumes it). */
  focusSeq: number
  takeFocus: () => boolean
}

type Outcome = { kind: 'done'; result: SearchResult } | { kind: 'error'; message: string }

interface Group {
  path: string
  matches: SearchMatch[]
}

function groupByFile(matches: SearchMatch[]): Group[] {
  const groups: Group[] = []
  for (const m of matches) {
    const last = groups.at(-1)
    if (last?.path === m.path) last.matches.push(m)
    else groups.push({ path: m.path, matches: [m] })
  }
  return groups
}

const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

/** The Search tab: a query with case and regex toggles, and the matching lines grouped by file. */
export function SearchView(p: SearchViewProps): React.JSX.Element {
  const { api, target, state, onState } = p
  const { query, caseSensitive, regex } = state
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  // Only the latest search's answer is shown.
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The query of the last search started: a toggle on the same query searches again without waiting.
  const lastQuery = useRef<string | null>(null)
  // The first search (the tab reopened with a query) doesn't wait either.
  const mounted = useRef(false)

  const run = useLatestCallback((): void => {
    clearTimeout(timer.current)
    const id = ++seq.current
    if (query.trim() === '') {
      lastQuery.current = null
      setOutcome(null)
      setBusy(false)
      return
    }
    lastQuery.current = query
    setBusy(true)
    api.searchFiles(target, query, { caseSensitive, regex }).then(
      (result) => {
        if (id !== seq.current) return
        setOutcome({ kind: 'done', result })
        setCollapsed(new Set())
        setBusy(false)
      },
      (err: unknown) => {
        if (id !== seq.current) return
        setOutcome({ kind: 'error', message: cleanError(err) })
        setBusy(false)
      },
    )
  })

  useEffect(() => {
    const now = !mounted.current || lastQuery.current === query || query.trim() === ''
    mounted.current = true
    timer.current = setTimeout(run, now ? 0 : SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer.current)
  }, [run, query, caseSensitive, regex, p.reload])

  // A stale answer must not land after unmounting.
  useEffect(
    () => () => {
      seq.current++
    },
    [],
  )

  const { takeFocus } = p
  useEffect(() => {
    if (!takeFocus()) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [p.focusSeq, takeFocus])

  const groups = useMemo(() => (outcome?.kind === 'done' ? groupByFile(outcome.result.matches) : []), [outcome])
  const toggleGroup = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  /** The files' and matches' buttons shown, top to bottom. */
  const resultButtons = (): HTMLElement[] => [
    ...(resultsRef.current?.querySelectorAll<HTMLElement>('.search-file, .search-hit') ?? []),
  ]
  // ↑/↓ move through the files and matches (↑ from the first goes back to the input), Home/End to the ends; on a
  // file ←/→ fold and unfold its matches, on a match ← goes to its file.
  const onResultsKey = (e: React.KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const buttons = resultButtons()
    const i = buttons.indexOf(e.target as HTMLElement)
    if (i === -1) return
    const el = buttons[i]
    const file = el.classList.contains('search-file')
    const open = el.getAttribute('aria-expanded') === 'true'
    let next: HTMLElement | null | undefined
    if (e.key === 'ArrowDown') next = buttons[i + 1]
    else if (e.key === 'ArrowUp') next = i === 0 ? inputRef.current : buttons[i - 1]
    else if (e.key === 'Home') next = buttons[0]
    else if (e.key === 'End') next = buttons.at(-1)
    else if (e.key === 'ArrowLeft' && !file)
      next = buttons.slice(0, i).findLast((b) => b.classList.contains('search-file'))
    else if ((e.key === 'ArrowLeft' && file && open) || (e.key === 'ArrowRight' && file && !open)) {
      e.preventDefault()
      el.click()
      return
    }
    if (!next) return
    e.preventDefault()
    next.focus()
  }

  const result = outcome?.kind === 'done' ? outcome.result : null
  return (
    <div className="search-view">
      <div className="search-box">
        <input
          ref={inputRef}
          className="search-input"
          aria-label="Search in files"
          placeholder={`Search in files (${shortcutLabel('searchFiles')})`}
          spellCheck={false}
          maxLength={MAX_SEARCH_QUERY}
          value={query}
          onChange={(e) => onState({ ...state, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              run()
            } else if (e.key === 'ArrowDown') {
              // Into the results, at the first match.
              const first = resultsRef.current?.querySelector<HTMLElement>('.search-hit')
              if (first) {
                e.preventDefault()
                first.focus()
              }
            } else if (e.key === 'Escape' && query !== '') {
              e.preventDefault()
              onState({ ...state, query: '' })
            }
          }}
        />
        <button
          className="search-toggle"
          aria-pressed={caseSensitive}
          aria-label="Match case"
          title="Match case"
          onClick={() => onState({ ...state, caseSensitive: !caseSensitive })}
        >
          Aa
        </button>
        <button
          className="search-toggle search-toggle-mono"
          aria-pressed={regex}
          aria-label="Use regular expression"
          title="Use regular expression"
          onClick={() => onState({ ...state, regex: !regex })}
        >
          .*
        </button>
      </div>
      <div className="search-status" role="status">
        {busy ? (
          <span className="search-busy">Searching…</span>
        ) : result ? (
          result.matches.length === 0 ? (
            'No results.'
          ) : (
            `${plural(result.matches.length, 'result')} in ${plural(groups.length, 'file')}`
          )
        ) : null}
      </div>
      <div className="search-results" ref={resultsRef} onKeyDown={onResultsKey}>
        {outcome?.kind === 'error' && (
          <p className="search-error" role="alert">
            {outcome.message}
          </p>
        )}
        {result?.truncated && (
          <div className="panel-notice">
            {result.matches.length >= MAX_SEARCH_MATCHES
              ? `Showing the first ${MAX_SEARCH_MATCHES} results. Refine the search to see the rest.`
              : 'This folder is very large: not every file was searched.'}
          </div>
        )}
        {result?.note && <div className="panel-notice">{result.note}</div>}
        {!outcome && !busy && <p className="panel-hint">Type to search the contents of every file.</p>}
        {groups.map((g) => {
          const open = !collapsed.has(g.path)
          const slash = g.path.lastIndexOf('/')
          return (
            <div className="search-group" key={g.path}>
              <button className="search-file" aria-expanded={open} title={g.path} onClick={() => toggleGroup(g.path)}>
                <span className={open ? 'tree-caret open' : 'tree-caret'} aria-hidden="true">
                  ▸
                </span>
                <span className="search-file-name">{g.path.slice(slash + 1)}</span>
                <span className="search-file-dir">{slash > 0 ? g.path.slice(0, slash) : ''}</span>
                <span className="panel-count">{g.matches.length}</span>
              </button>
              {open &&
                g.matches.map((m) => (
                  <button
                    key={`${m.line}:${m.column}`}
                    className="search-hit"
                    aria-label={`${m.path}, line ${m.line}: ${m.preview}`}
                    title={`${m.path}:${m.line}:${m.column}`}
                    onClick={() => p.onOpen(m)}
                  >
                    <span className="search-ln">{m.line}</span>
                    <span className="search-text">
                      {m.preview.slice(0, m.matchStart)}
                      <mark>{m.preview.slice(m.matchStart, m.matchStart + m.matchLength)}</mark>
                      {m.preview.slice(m.matchStart + m.matchLength)}
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
